"""QEMU process lifecycle + minimal QMP client.

We roll a small JSON-RPC-over-Unix-socket client instead of pulling
qemu.qmp from PyPI; QMP is simple enough that the dependency isn't
worth the version-skew exposure.
"""

from __future__ import annotations

import asyncio
import json
import re
import shutil
import subprocess
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, AsyncIterator, Optional

from .machines import MACHINES


class QMPError(Exception):
    pass


class QMPClient:
    """Minimal asyncio QMP client.

    Talks to QEMU over a Unix socket using newline-delimited JSON.
    Requests are serialized through a single-flight queue; events flow
    into a separate queue that callers can consume via `events()`.
    """

    def __init__(self) -> None:
        self._reader: Optional[asyncio.StreamReader] = None
        self._writer: Optional[asyncio.StreamWriter] = None
        self._reader_task: Optional[asyncio.Task] = None
        self._response_queue: asyncio.Queue = asyncio.Queue()
        self._event_queue: asyncio.Queue = asyncio.Queue()
        self._command_lock = asyncio.Lock()

    async def connect(self, socket_path: Path) -> None:
        self._reader, self._writer = await asyncio.open_unix_connection(
            path=str(socket_path))
        # First message from QEMU is the greeting (QMP capabilities).
        greeting_line = await self._reader.readline()
        if not greeting_line:
            raise QMPError("QEMU closed the QMP socket before sending greeting")
        json.loads(greeting_line)  # parse to validate; we don't use the contents
        # Negotiate capabilities (no extra caps for v0).
        await self._send({"execute": "qmp_capabilities"})
        ack = json.loads(await self._reader.readline())
        if "error" in ack:
            raise QMPError(ack["error"])
        # Hand off to the background reader for further messages.
        self._reader_task = asyncio.create_task(self._read_loop())

    async def _read_loop(self) -> None:
        try:
            while True:
                line = await self._reader.readline()
                if not line:
                    break  # peer closed
                msg = json.loads(line)
                if "event" in msg:
                    await self._event_queue.put(msg)
                else:
                    await self._response_queue.put(msg)
        except (asyncio.CancelledError, ConnectionResetError):
            pass
        finally:
            # Wake up any pending consumers with sentinels.
            await self._event_queue.put(None)
            await self._response_queue.put({"error": {"desc": "QMP disconnected"}})

    async def _send(self, msg: dict) -> None:
        if not self._writer:
            raise QMPError("Not connected")
        data = (json.dumps(msg) + "\n").encode()
        self._writer.write(data)
        await self._writer.drain()

    async def execute(self, command: str, arguments: Optional[dict] = None) -> Any:
        async with self._command_lock:
            msg = {"execute": command}
            if arguments is not None:
                msg["arguments"] = arguments
            await self._send(msg)
            response = await self._response_queue.get()
        if "error" in response:
            raise QMPError(response["error"].get("desc", str(response["error"])))
        return response.get("return", {})

    async def events(self) -> AsyncIterator[dict]:
        while True:
            event = await self._event_queue.get()
            if event is None:
                return
            yield event

    async def disconnect(self) -> None:
        if self._reader_task:
            self._reader_task.cancel()
            try:
                await self._reader_task
            except asyncio.CancelledError:
                pass
        if self._writer:
            try:
                self._writer.close()
                await self._writer.wait_closed()
            except Exception:
                pass


class QEMUSession:
    """One emulator session: spawns QEMU, drives QMP, exposes UART sockets."""

    def __init__(self, machine: str, smp: int, kernel: Path, ram_mb: int) -> None:
        if machine not in MACHINES:
            raise ValueError(f"unknown machine '{machine}'")
        self.id = "session-1"
        self.machine = machine
        self.smp = smp
        self.kernel = kernel
        self.ram_mb = ram_mb
        self.status = "created"
        self.created_at = datetime.now(timezone.utc)
        self.started_at: Optional[datetime] = None
        self.exit_code: Optional[int | str] = None

        self._runtime_dir = Path(tempfile.mkdtemp(prefix="qemu-session-"))
        self._qmp_socket = self._runtime_dir / "qmp.sock"
        self._uart_count = MACHINES[machine]["uart_count"]
        self._uart_sockets = [self._runtime_dir / f"uart{i}.sock"
                              for i in range(self._uart_count)]

        self._process: Optional[asyncio.subprocess.Process] = None
        self._qmp: Optional[QMPClient] = None
        self._event_subscribers: list[asyncio.Queue] = []
        self._event_pump_task: Optional[asyncio.Task] = None
        self._exit_watcher_task: Optional[asyncio.Task] = None

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    @property
    def uart_socket_path(self) -> list[Path]:
        return self._uart_sockets

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "machine": self.machine,
            "status": self.status,
            "smp": self.smp,
            "kernel_url": f"/uploads/{self.kernel.name}",
            "ram_mb": self.ram_mb,
            "created_at": self.created_at.isoformat().replace("+00:00", "Z"),
            "started_at": (self.started_at.isoformat().replace("+00:00", "Z")
                           if self.started_at else None),
            "exit_code": self.exit_code,
        }

    async def start(self) -> None:
        if self.status != "created":
            raise QMPError(f"cannot start from state '{self.status}'")

        cmd = self._build_command()
        self._process = await asyncio.create_subprocess_exec(
            *cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)

        # Wait for the QMP socket to appear (QEMU creates it during init).
        deadline = asyncio.get_running_loop().time() + 5.0
        while not self._qmp_socket.exists():
            if asyncio.get_running_loop().time() > deadline:
                stderr = (await self._process.stderr.read()).decode(errors="replace")
                raise QMPError(f"QEMU did not create QMP socket within 5s. "
                               f"stderr:\n{stderr}")
            if self._process.returncode is not None:
                stderr = (await self._process.stderr.read()).decode(errors="replace")
                raise QMPError(f"QEMU exited during startup. stderr:\n{stderr}")
            await asyncio.sleep(0.05)

        self._qmp = QMPClient()
        await self._qmp.connect(self._qmp_socket)
        # QEMU was launched with -S; release it.
        await self._qmp.execute("cont")
        self.status = "running"
        self.started_at = datetime.now(timezone.utc)

        # Background tasks: pump QMP events into subscriber queues, and
        # watch for the QEMU process exiting.
        self._event_pump_task = asyncio.create_task(self._pump_events())
        self._exit_watcher_task = asyncio.create_task(self._watch_exit())

    async def pause(self) -> None:
        if self.status != "running":
            raise QMPError(f"cannot pause from state '{self.status}'")
        await self._qmp.execute("stop")
        self.status = "paused"
        await self._broadcast_status()

    async def resume(self) -> None:
        if self.status != "paused":
            raise QMPError(f"cannot resume from state '{self.status}'")
        await self._qmp.execute("cont")
        self.status = "running"
        await self._broadcast_status()

    async def reset(self) -> None:
        if self.status == "created":
            raise QMPError("cannot reset before start")
        await self._qmp.execute("system_reset")
        if self.status == "exited":
            await self._qmp.execute("cont")
        self.status = "running"
        await self._broadcast_status()

    async def stop(self) -> None:
        # Cancel watchers first so we don't double-emit events.
        for task in (self._event_pump_task, self._exit_watcher_task):
            if task:
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass
        if self._qmp:
            try:
                await self._qmp.execute("quit")
            except Exception:
                pass
            await self._qmp.disconnect()
        if self._process and self._process.returncode is None:
            try:
                await asyncio.wait_for(self._process.wait(), timeout=2.0)
            except asyncio.TimeoutError:
                self._process.kill()
                await self._process.wait()
        # Clean up runtime directory (sockets, etc.).
        shutil.rmtree(self._runtime_dir, ignore_errors=True)

    # ------------------------------------------------------------------
    # Introspection (HMP-based for MVP)
    # ------------------------------------------------------------------

    async def query_registers(self, cpu: int) -> dict:
        if cpu < 0 or cpu >= self.smp:
            raise ValueError("cpu out of range")
        if self.status == "created":
            raise QMPError("cannot query registers before start")
        # `info registers -a` dumps all CPUs separated by "CPU#N" headers.
        text = await self._qmp.execute("human-monitor-command",
                                       {"command-line": "info registers -a"})
        return _parse_sparc_registers(text, cpu)

    async def query_memory(self, addr: int, size: int) -> str:
        if size <= 0 or size > 4096:
            raise ValueError("size out of range")
        if self.status == "created":
            raise QMPError("cannot query memory before start")
        # `xp/<size>b <addr>` dumps physical memory as bytes; we group
        # them back into 32-bit BE words for the response.
        cmd = f"xp/{size}b 0x{addr:08x}"
        text = await self._qmp.execute("human-monitor-command",
                                       {"command-line": cmd})
        return _format_memory_dump(text, addr, size)

    # ------------------------------------------------------------------
    # Event subscription
    # ------------------------------------------------------------------

    def subscribe_events(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue()
        self._event_subscribers.append(q)
        return q

    def unsubscribe_events(self, q: asyncio.Queue) -> None:
        if q in self._event_subscribers:
            self._event_subscribers.remove(q)

    async def _broadcast_status(self) -> None:
        msg = {
            "type": "status",
            "session_id": self.id,
            "status": self.status,
            "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        }
        for q in list(self._event_subscribers):
            try:
                q.put_nowait(msg)
            except asyncio.QueueFull:
                pass

    async def _broadcast_exit(self, exit_code: int | str) -> None:
        msg = {
            "type": "exit" if isinstance(exit_code, int) else "fatal",
            "session_id": self.id,
            "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        }
        if isinstance(exit_code, int):
            msg["exit_code"] = exit_code
        for q in list(self._event_subscribers):
            try:
                q.put_nowait(msg)
            except asyncio.QueueFull:
                pass

    # ------------------------------------------------------------------
    # Private helpers
    # ------------------------------------------------------------------

    def _build_command(self) -> list[str]:
        cmd = [
            "qemu-system-sparc",
            "-M", self.machine,
            "-smp", str(self.smp),
            "-m", f"{self.ram_mb}M",
            "-nographic",
            "-kernel", str(self.kernel),
            "-S",  # start stopped; we cont() once QMP is up
            "-qmp", f"unix:{self._qmp_socket},server=on,wait=off",
            "-monitor", "null",
        ]
        for i, sock in enumerate(self._uart_sockets):
            chardev_id = f"uart{i}"
            cmd.extend([
                "-chardev", f"socket,id={chardev_id},path={sock},server=on,wait=off",
                "-serial", f"chardev:{chardev_id}",
            ])
        return cmd

    async def _pump_events(self) -> None:
        try:
            async for event in self._qmp.events():
                name = event.get("event")
                if name == "STOP":
                    self.status = "paused"
                    await self._broadcast_status()
                elif name == "RESUME":
                    if self.status != "running":
                        self.status = "running"
                        await self._broadcast_status()
                elif name == "SHUTDOWN":
                    # Caused by guest exit() or QEMU quit; the watcher
                    # task will set status when the process actually dies.
                    pass
                elif name == "RESET":
                    pass
        except asyncio.CancelledError:
            raise
        except Exception:
            pass

    async def _watch_exit(self) -> None:
        try:
            await self._process.wait()
        except asyncio.CancelledError:
            raise
        # Process is gone. Determine why.
        if self.status == "exited":
            return  # already handled
        rc = self._process.returncode
        # QEMU exits 0 on RTEMS exit() via SHUTDOWN; non-zero on internal error.
        # We surface 0 as a clean exit, anything else as fatal.
        if rc == 0:
            self.exit_code = 0
            self.status = "exited"
            await self._broadcast_exit(0)
        else:
            self.exit_code = "fatal"
            self.status = "exited"
            await self._broadcast_exit("fatal")


# ----------------------------------------------------------------------
# Output parsers (HMP textual format)
# ----------------------------------------------------------------------

_REG_HEADER_RE = re.compile(r"^CPU#(\d+)", re.MULTILINE)
_HEX_VALUE_RE = re.compile(r"\b([0-9a-fA-F]{8})\b")


def _parse_sparc_registers(text: str, cpu: int) -> dict:
    """Best-effort parser for QEMU's SPARC `info registers` output.

    The textual format is not part of QEMU's stable API, so this parser
    is intentionally lenient: anything we can't extract becomes 0x0.
    """
    # Split at CPU#N markers.
    sections: list[tuple[int, str]] = []
    last_pos = 0
    last_cpu = 0
    for m in _REG_HEADER_RE.finditer(text):
        if last_pos:
            sections.append((last_cpu, text[last_pos:m.start()]))
        last_cpu = int(m.group(1))
        last_pos = m.end()
    if last_pos:
        sections.append((last_cpu, text[last_pos:]))
    # If no CPU# markers (single CPU), the whole text is for cpu 0.
    if not sections:
        sections.append((0, text))

    section = next((s for c, s in sections if c == cpu), None)
    if section is None:
        return _empty_registers(cpu)

    return _registers_from_block(section, cpu)


def _registers_from_block(block: str, cpu: int) -> dict:
    """Extract a register snapshot from one CPU#N block of QEMU output.

    QEMU's SPARC format emits one line per register window with eight
    hex values:
      %g0-7: 00000000 40001920 0a010001 ...
    Scalar registers appear as `name: hex` (no 0x prefix), sometimes
    followed by parenthetical decoded flags.
    """
    def grab_scalar(name: str) -> str:
        m = re.search(rf"\b{name}\s*:\s*([0-9a-fA-F]+)", block)
        return f"0x{int(m.group(1), 16):08x}" if m else "0x00000000"

    def grab_window(prefix: str) -> list[str]:
        m = re.search(rf"%{prefix}0-7:\s*((?:[0-9a-fA-F]+\s+){{7}}[0-9a-fA-F]+)",
                       block)
        if not m:
            return ["0x00000000"] * 8
        values = m.group(1).split()
        return [f"0x{int(v, 16):08x}" for v in values[:8]]

    return {
        "cpu":    cpu,
        "pc":     grab_scalar("pc"),
        "npc":    grab_scalar("npc"),
        "psr":    grab_scalar("psr"),
        "y":      grab_scalar("y"),
        "wim":    grab_scalar("wim"),
        "tbr":    grab_scalar("tbr"),
        "asr17":  "0x00000000",  # not in `info registers -a` output for SPARC
        "global": grab_window("g"),
        "out":    grab_window("o"),
        "local":  grab_window("l"),
        "in":     grab_window("i"),
    }


def _empty_registers(cpu: int) -> dict:
    z = "0x00000000"
    return {
        "cpu": cpu, "pc": z, "npc": z, "psr": z, "y": z, "wim": z, "tbr": z,
        "asr17": z,
        "global": [z] * 8, "out": [z] * 8, "local": [z] * 8, "in": [z] * 8,
    }


_BYTE_LINE_RE = re.compile(r"^[0-9a-fA-F]+:\s+((?:0x[0-9a-fA-F]{2}\s*)+)",
                           re.MULTILINE)


def _format_memory_dump(text: str, addr: int, size: int) -> str:
    """Convert the `xp/Nb` HMP output to a space-separated word string.

    Input lines look like:
      0xc0000000: 0x82 0x10 0x00 0x00 0x03 0x30 0x00 0x00
    Output (32-bit big-endian words):
      "82100000 03300000 ..."
    """
    bytes_ = bytearray()
    for m in _BYTE_LINE_RE.finditer(text):
        for tok in m.group(1).split():
            bytes_.append(int(tok, 16))
    bytes_ = bytes_[:size]

    words = []
    for i in range(0, len(bytes_) - len(bytes_) % 4, 4):
        word = (bytes_[i] << 24) | (bytes_[i + 1] << 16) \
             | (bytes_[i + 2] << 8) | bytes_[i + 3]
        words.append(f"{word:08x}")
    # Tail bytes if the size wasn't a multiple of 4
    tail = bytes_[len(bytes_) - len(bytes_) % 4:]
    if tail:
        words.extend(f"{b:02x}" for b in tail)
    return " ".join(words)
