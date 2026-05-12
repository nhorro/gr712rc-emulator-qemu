#!/usr/bin/env python3
"""
SpaceWire echo peer for QEMU's GRLIB GRSPW2 model.

QEMU exposes each SpW link as a chardev (typically a TCP server socket
via -chardev socket,id=spwN,host=...,port=...,server=on,wait=off).  The
device frames each outgoing packet with a 4-byte big-endian length
prefix; this script parses that framing, increments the trailing 32-bit
big-endian integer in the payload, reframes it, and writes it back.

Usage:
    python3 tools/spw-echo-peer.py --port 5101

The peer listens by default (--connect to dial out instead).  Single
client at a time; exits cleanly on EOF / SIGINT.
"""
import argparse
import socket
import struct
import sys


def recv_exact(sock: socket.socket, n: int) -> bytes:
    buf = bytearray()
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            return bytes(buf) if buf else b""
        buf.extend(chunk)
    return bytes(buf)


def serve(conn: socket.socket, peer: str, inc: int, verbose: bool) -> None:
    while True:
        hdr = recv_exact(conn, 4)
        if len(hdr) < 4:
            print(f"[peer] {peer}: connection closed", file=sys.stderr)
            return
        (length,) = struct.unpack(">I", hdr)
        if length == 0:
            payload = b""
        else:
            payload = recv_exact(conn, length)
            if len(payload) < length:
                print(f"[peer] {peer}: short read ({len(payload)}/{length})",
                      file=sys.stderr)
                return

        if length >= 4:
            (counter,) = struct.unpack(">I", payload[-4:])
            new_payload = payload[:-4] + struct.pack(">I", counter + inc)
            if verbose:
                print(f"[peer] {peer}: rx counter={counter} "
                      f"len={length} -> tx counter={counter + inc}")
        else:
            new_payload = payload
            if verbose:
                print(f"[peer] {peer}: rx len={length} (no counter, "
                      "echoing as-is)")

        conn.sendall(struct.pack(">I", length) + new_payload)


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--port", type=int, required=True,
                   help="TCP port (matches QEMU -chardev socket port)")
    p.add_argument("--listen", default="0.0.0.0",
                   help="Address to bind/listen on (default: 0.0.0.0)")
    p.add_argument("--connect", action="store_true",
                   help="Dial out instead of listening "
                        "(use with QEMU server=off)")
    p.add_argument("--inc", type=int, default=1,
                   help="Amount to add to the trailing uint32 (default: 1)")
    p.add_argument("-v", "--verbose", action="store_true")
    args = p.parse_args()

    if args.connect:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        sock.connect((args.listen, args.port))
        peer = f"{args.listen}:{args.port}"
        print(f"[peer] connected to {peer}")
        try:
            serve(sock, peer, args.inc, args.verbose)
        finally:
            sock.close()
        return 0

    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind((args.listen, args.port))
    listener.listen(1)
    print(f"[peer] listening on {args.listen}:{args.port}")

    try:
        while True:
            conn, addr = listener.accept()
            conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            peer = f"{addr[0]}:{addr[1]}"
            print(f"[peer] accepted {peer}")
            try:
                serve(conn, peer, args.inc, args.verbose)
            finally:
                conn.close()
    except KeyboardInterrupt:
        print("\n[peer] exiting", file=sys.stderr)
        return 0
    finally:
        listener.close()


if __name__ == "__main__":
    sys.exit(main())
