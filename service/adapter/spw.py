"""SpaceWire (GRSPW2) tap proxy.

The QEMU GRSPW2 chardev frames each packet as a 4-byte big-endian
length prefix followed by the raw packet bytes (header+payload). This
module sits between QEMU and an external SpW peer (e.g.
`tools/spw-echo-peer.py`), forwarding bytes verbatim in both directions
while parsing the framing to publish per-packet observability events
to subscribed WebSocket clients.

Topology, per port:

    QEMU  ──TCP──►  service:qemu_port  ──forwards──►  service:peer_port  ◄──TCP──  external peer
                                       ◄──forwards──

Both forward paths are taps: the bytes are also parsed and emitted as
events. Either side may connect or disconnect independently; with no
peer attached the QEMU side still produces events (its packets just
don't reach any peer until one connects).
"""

from __future__ import annotations

import asyncio
import time
from datetime import datetime, timezone
from typing import Optional

# 65536-byte payload cap matches the GRSPW2 model's MAX_PACKET; add 4
# for the length prefix. Anything beyond that is treated as a stream
# desynchronisation (peer feeding garbage) — we drop the connection.
_MAX_PACKET = 65536


class SpwTap:
    """Per-port tap that proxies QEMU↔peer and publishes packet events.

    The class owns two asyncio TCP listeners (qemu side, peer side).
    A single connection per side is supported; if a second client tries
    to connect, the new socket is closed immediately. This matches
    QEMU's chardev semantics (one consumer at a time).
    """

    def __init__(self, port_index: int, peer_port: int = 0) -> None:
        """`peer_port=0` requests an ephemeral OS-assigned port (used by
        unit tests). Production launches pass a deterministic value so
        Docker port-publishing can pin a fixed external port."""
        self.port_index = port_index
        self.qemu_port: int = 0   # filled in by start()
        self.peer_port: int = 0
        self._peer_port_request = peer_port

        self._qemu_server: Optional[asyncio.AbstractServer] = None
        self._peer_server: Optional[asyncio.AbstractServer] = None
        self._qemu_writer: Optional[asyncio.StreamWriter] = None
        self._peer_writer: Optional[asyncio.StreamWriter] = None

        self._subscribers: list[asyncio.Queue] = []
        self._stopped = False

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def start(self, qemu_host: str = "127.0.0.1",
                    peer_host: str = "0.0.0.0") -> None:
        """Bind the QEMU listener (loopback only — QEMU is in-process or
        in the same container) and the peer listener (exposed by default
        so an external peer can dial in)."""
        self._qemu_server = await asyncio.start_server(
            self._handle_qemu, host=qemu_host, port=0)
        self._peer_server = await asyncio.start_server(
            self._handle_peer, host=peer_host, port=self._peer_port_request)
        self.qemu_port = self._qemu_server.sockets[0].getsockname()[1]
        self.peer_port = self._peer_server.sockets[0].getsockname()[1]

    async def stop(self) -> None:
        self._stopped = True
        for srv in (self._qemu_server, self._peer_server):
            if srv is not None:
                srv.close()
                try:
                    await srv.wait_closed()
                except Exception:
                    pass
        for w in (self._qemu_writer, self._peer_writer):
            if w is not None:
                try:
                    w.close()
                    await w.wait_closed()
                except Exception:
                    pass
        # Wake any pending subscribers so they can shut down cleanly.
        for q in list(self._subscribers):
            try:
                q.put_nowait(None)
            except asyncio.QueueFull:
                pass

    # ------------------------------------------------------------------
    # Subscription (consumed by WS endpoints)
    # ------------------------------------------------------------------

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=1024)
        self._subscribers.append(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        if q in self._subscribers:
            self._subscribers.remove(q)

    # ------------------------------------------------------------------
    # Connection handlers
    # ------------------------------------------------------------------

    async def _handle_qemu(self, reader: asyncio.StreamReader,
                           writer: asyncio.StreamWriter) -> None:
        # Single connection: reject duplicates so chardev semantics are clear.
        if self._qemu_writer is not None:
            writer.close()
            return
        self._qemu_writer = writer
        self._publish_state("qemu_connected")
        try:
            await self._pump(reader, get_target=lambda: self._peer_writer,
                             direction="tx")
        finally:
            self._qemu_writer = None
            try:
                writer.close()
                await writer.wait_closed()
            except Exception:
                pass
            self._publish_state("qemu_disconnected")

    async def _handle_peer(self, reader: asyncio.StreamReader,
                           writer: asyncio.StreamWriter) -> None:
        if self._peer_writer is not None:
            writer.close()
            return
        self._peer_writer = writer
        self._publish_state("peer_connected")
        try:
            await self._pump(reader, get_target=lambda: self._qemu_writer,
                             direction="rx")
        finally:
            self._peer_writer = None
            try:
                writer.close()
                await writer.wait_closed()
            except Exception:
                pass
            self._publish_state("peer_disconnected")

    # ------------------------------------------------------------------
    # Packet-aware forwarder
    # ------------------------------------------------------------------

    async def _pump(self, reader: asyncio.StreamReader,
                    get_target, direction: str) -> None:
        """Forward bytes packet-by-packet while emitting tap events.

        We parse the 4-byte BE length prefix and read the full packet
        before forwarding it; this guarantees the tap event and the
        forwarded bytes describe the same boundary, and naturally
        rejects malformed/oversized streams.
        """
        try:
            while True:
                hdr = await reader.readexactly(4)
                length = int.from_bytes(hdr, "big")
                if length > _MAX_PACKET:
                    # Garbage — bail out, the connection is unusable.
                    return
                payload = await reader.readexactly(length) if length else b""

                target = get_target()
                if target is not None and not target.is_closing():
                    try:
                        target.write(hdr + payload)
                        await target.drain()
                    except Exception:
                        # Peer closed mid-write; drop the side, keep us alive.
                        pass

                self._publish_packet(direction, payload)
        except (asyncio.IncompleteReadError, ConnectionResetError,
                BrokenPipeError):
            return
        except asyncio.CancelledError:
            raise
        except Exception:
            return

    # ------------------------------------------------------------------
    # Event publishing
    # ------------------------------------------------------------------

    def _publish_packet(self, direction: str, payload: bytes) -> None:
        msg = {
            "type": "packet",
            "port": self.port_index,
            "ts": time.time(),
            "iso": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "dir": direction,
            "len": len(payload),
            "hex": payload.hex(),
        }
        self._broadcast(msg)

    def _publish_state(self, kind: str) -> None:
        msg = {
            "type": "state",
            "port": self.port_index,
            "ts": time.time(),
            "iso": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "state": kind,
        }
        self._broadcast(msg)

    def _broadcast(self, msg: dict) -> None:
        for q in list(self._subscribers):
            try:
                q.put_nowait(msg)
            except asyncio.QueueFull:
                # Drop — a slow consumer must not stall the pump.
                pass
