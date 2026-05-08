"""Bidirectional pump between a QEMU chardev Unix socket and a WebSocket."""

from __future__ import annotations

import asyncio
from pathlib import Path

from fastapi import WebSocket, WebSocketDisconnect


async def pump(socket_path: Path, ws: WebSocket) -> None:
    """Wire one QEMU UART socket to a WebSocket text-frame channel.

    Server → client: bytes from the QEMU UART are decoded as UTF-8
    (with replacement) and sent as text frames. Frame boundaries do not
    correspond to lines; clients buffer themselves.

    Client → server: each text frame's UTF-8 bytes are written verbatim
    to the UART RX. Send a `\n` to submit a line.
    """
    # The QEMU chardev socket is created with `server=on,wait=off`, which
    # means QEMU is listening. We connect as a client.
    reader, writer = await asyncio.open_unix_connection(path=str(socket_path))

    async def qemu_to_ws() -> None:
        try:
            while True:
                chunk = await reader.read(1024)
                if not chunk:
                    return
                await ws.send_text(chunk.decode("utf-8", errors="replace"))
        except (asyncio.CancelledError, ConnectionResetError, WebSocketDisconnect):
            raise
        except Exception:
            return

    async def ws_to_qemu() -> None:
        try:
            while True:
                msg = await ws.receive_text()
                writer.write(msg.encode("utf-8"))
                await writer.drain()
        except (asyncio.CancelledError, WebSocketDisconnect, ConnectionResetError):
            raise
        except Exception:
            return

    task_q2w = asyncio.create_task(qemu_to_ws())
    task_w2q = asyncio.create_task(ws_to_qemu())
    try:
        done, pending = await asyncio.wait(
            {task_q2w, task_w2q}, return_when=asyncio.FIRST_COMPLETED)
        for t in pending:
            t.cancel()
            try:
                await t
            except (asyncio.CancelledError, Exception):
                pass
    finally:
        writer.close()
        try:
            await writer.wait_closed()
        except Exception:
            pass
