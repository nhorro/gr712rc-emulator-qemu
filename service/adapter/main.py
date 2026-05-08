"""FastAPI service entrypoint — implements the v0 spec at docs/07-adapter-api.md."""

from __future__ import annotations

import asyncio
import os
import shutil
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, File, HTTPException, Request, UploadFile, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response

from .machines import MACHINES
from .models import (CreateSessionRequest, ErrorResponse, MemoryResponse,
                     Session as SessionModel, Upload)
from .qemu import QEMUSession, QMPError
from .uart import pump as uart_pump

UPLOADS_DIR = Path(os.environ.get("UPLOADS_DIR", "/var/uploads"))
UPLOADS_DIR.mkdir(parents=True, exist_ok=True)

# Global single-session state. The adapter intentionally serves one
# session at a time (see spec §1).
_session: Optional[QEMUSession] = None
_session_lock = asyncio.Lock()


def _err(code: str, message: str, status: int, details: dict | None = None):
    return JSONResponse(
        status_code=status,
        content={"error": code, "message": message, "details": details or {}},
    )


app = FastAPI(
    title="GR712RC / GR740 emulator adapter",
    version="0.1.0",
    description="Wraps qemu-system-sparc with HTTP + WebSocket control plane. "
                "See docs/07-adapter-api.md for the contract.",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
    allow_credentials=False,
)


# ----------------------------------------------------------------------
# Machines
# ----------------------------------------------------------------------

@app.get("/machines")
async def list_machines() -> list[dict]:
    return list(MACHINES.values())


# ----------------------------------------------------------------------
# Uploads (ephemeral; wiped on container restart)
# ----------------------------------------------------------------------

@app.post("/uploads", status_code=201)
async def upload_kernel(file: UploadFile = File(...)):
    if not file.filename:
        return _err("invalid_kernel", "missing filename", 400)

    file_id = uuid.uuid4().hex[:12]
    safe_name = Path(file.filename).name
    target = UPLOADS_DIR / f"{file_id}-{safe_name}"

    size = 0
    LIMIT = 32 * 1024 * 1024
    with target.open("wb") as out:
        while True:
            chunk = await file.read(64 * 1024)
            if not chunk:
                break
            size += len(chunk)
            if size > LIMIT:
                target.unlink(missing_ok=True)
                return _err("kernel_too_large",
                            f"file exceeds {LIMIT // (1024 * 1024)} MiB limit", 413)
            out.write(chunk)
    if size == 0:
        target.unlink(missing_ok=True)
        return _err("invalid_kernel", "uploaded file is empty", 400)

    return {
        "kernel_url": f"/uploads/{target.name}",
        "filename": safe_name,
        "size": size,
        "uploaded_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }


@app.get("/uploads/{name}")
async def download_kernel(name: str):
    path = UPLOADS_DIR / Path(name).name
    if not path.exists():
        return _err("invalid_kernel", "no such upload", 404)
    return FileResponse(path, media_type="application/octet-stream")


# ----------------------------------------------------------------------
# Session
# ----------------------------------------------------------------------

def _resolve_kernel(kernel_url: str) -> Optional[Path]:
    if not kernel_url.startswith("/uploads/"):
        return None
    name = Path(kernel_url[len("/uploads/"):]).name
    p = UPLOADS_DIR / name
    return p if p.exists() else None


@app.post("/session", status_code=201)
async def create_session(req: CreateSessionRequest):
    global _session
    async with _session_lock:
        if _session is not None:
            return _err("session_exists",
                        "A session is already active. DELETE /session first.", 409)

        if req.machine not in MACHINES:
            return _err("invalid_machine",
                        f"unknown machine '{req.machine}'", 400,
                        details={"allowed": list(MACHINES.keys())})

        meta = MACHINES[req.machine]
        kernel = _resolve_kernel(req.kernel_url)
        if kernel is None:
            return _err("invalid_kernel",
                        "kernel_url does not point to an uploaded file", 400)

        smp = req.smp if req.smp is not None else meta["cpus"]
        if not (1 <= smp <= meta["cpus"]):
            return _err("invalid_machine",
                        f"smp must be in [1, {meta['cpus']}]", 400)
        ram_mb = req.ram_mb if req.ram_mb is not None else meta["default_ram_mb"]
        if not (1 <= ram_mb <= meta["max_ram_mb"]):
            return _err("invalid_machine",
                        f"ram_mb must be in [1, {meta['max_ram_mb']}]", 400)

        _session = QEMUSession(req.machine, smp, kernel, ram_mb)
        return _session.to_dict()


@app.get("/session")
async def get_session():
    if _session is None:
        return _err("session_not_found", "no active session", 404)
    return _session.to_dict()


@app.post("/session/start")
async def start_session():
    if _session is None:
        return _err("session_not_found", "no active session", 404)
    if _session.status != "created":
        return _err("invalid_state",
                    f"cannot start from '{_session.status}'", 409,
                    details={"current_status": _session.status,
                             "allowed_from": ["created"]})
    try:
        await _session.start()
    except QMPError as e:
        return _err("qemu_error", str(e), 502)
    await _session._broadcast_status()
    return _session.to_dict()


@app.post("/session/pause")
async def pause_session():
    if _session is None:
        return _err("session_not_found", "no active session", 404)
    try:
        await _session.pause()
    except QMPError as e:
        return _err("invalid_state", str(e), 409,
                    details={"current_status": _session.status,
                             "allowed_from": ["running"]})
    return _session.to_dict()


@app.post("/session/resume")
async def resume_session():
    if _session is None:
        return _err("session_not_found", "no active session", 404)
    try:
        await _session.resume()
    except QMPError as e:
        return _err("invalid_state", str(e), 409,
                    details={"current_status": _session.status,
                             "allowed_from": ["paused"]})
    return _session.to_dict()


@app.post("/session/reset")
async def reset_session():
    if _session is None:
        return _err("session_not_found", "no active session", 404)
    try:
        await _session.reset()
    except QMPError as e:
        return _err("invalid_state", str(e), 409)
    return _session.to_dict()


@app.delete("/session", status_code=204)
async def delete_session():
    global _session
    async with _session_lock:
        if _session is None:
            return _err("session_not_found", "no active session", 404)
        s = _session
        _session = None
    await s.stop()
    return Response(status_code=204)


# ----------------------------------------------------------------------
# Introspection
# ----------------------------------------------------------------------

@app.get("/session/cpu/{cpu}/registers")
async def get_registers(cpu: int):
    if _session is None:
        return _err("session_not_found", "no active session", 404)
    if cpu < 0 or cpu >= _session.smp:
        return _err("invalid_address", f"cpu must be in [0, {_session.smp})", 400)
    if _session.status == "created":
        return _err("invalid_state", "session not started", 409)
    try:
        return await _session.query_registers(cpu)
    except QMPError as e:
        return _err("qemu_error", str(e), 502)


@app.get("/session/memory")
async def get_memory(addr: str, size: int):
    if _session is None:
        return _err("session_not_found", "no active session", 404)
    if _session.status == "created":
        return _err("invalid_state", "session not started", 409)
    try:
        addr_int = int(addr, 16) if addr.lower().startswith("0x") else int(addr, 16)
    except ValueError:
        return _err("invalid_address", f"malformed addr '{addr}'", 400)
    if size <= 0 or size > 4096:
        return _err("invalid_size", "size must be in [1, 4096]", 400)
    try:
        data = await _session.query_memory(addr_int, size)
    except QMPError as e:
        return _err("qemu_error", str(e), 502)
    return {"addr": f"0x{addr_int:08x}", "size": size, "data": data}


# ----------------------------------------------------------------------
# WebSockets
# ----------------------------------------------------------------------

@app.websocket("/ws/uart/{n}")
async def ws_uart(websocket: WebSocket, n: int):
    if _session is None:
        await websocket.close(code=1011)
        return
    if _session.status == "created":
        await websocket.close(code=1011)
        return
    if n < 0 or n >= len(_session.uart_socket_path):
        await websocket.close(code=1011)
        return
    await websocket.accept()
    try:
        await uart_pump(_session.uart_socket_path[n], websocket)
    finally:
        try:
            await websocket.close()
        except Exception:
            pass


@app.websocket("/ws/events")
async def ws_events(websocket: WebSocket):
    if _session is None:
        await websocket.close(code=1011)
        return
    await websocket.accept()
    queue = _session.subscribe_events()
    # Send current status immediately so clients can sync without polling.
    await websocket.send_json({
        "type": "status",
        "session_id": _session.id,
        "status": _session.status,
        "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    })
    try:
        while True:
            msg = await queue.get()
            await websocket.send_json(msg)
    except Exception:
        pass
    finally:
        if _session is not None:
            _session.unsubscribe_events(queue)
        try:
            await websocket.close()
        except Exception:
            pass
