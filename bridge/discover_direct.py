"""Interface-targeted ScreenLogic discovery for multi-NIC machines.

The library's discovery binds to all interfaces and lets the OS pick where the
broadcast goes, which fails on machines with virtual adapters (WSL, Hamachi,
Hyper-V). This binds each given local IP explicitly and tries both the global
and subnet-directed broadcast addresses.
"""

import socket
import sys

from screenlogicpy.discovery import (
    DISCOVERY_PAYLOAD,
    DISCOVERY_PORT,
    process_discovery_response,
)

TIMEOUT = 3.0


def probe(local_ip, broadcast_ip):
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    sock.settimeout(TIMEOUT)
    try:
        sock.bind((local_ip, 0))
        sock.sendto(DISCOVERY_PAYLOAD, (broadcast_ip, DISCOVERY_PORT))
        data, addr = sock.recvfrom(1024)
        return process_discovery_response(data), addr
    except socket.timeout:
        return None, None
    finally:
        sock.close()


def main():
    local_ips = sys.argv[1:]
    if not local_ips:
        sys.exit("usage: discover_direct.py <local-ip> [<local-ip> ...]")

    found = False
    for local_ip in local_ips:
        parts = local_ip.rsplit(".", 1)
        subnet_bcast = parts[0] + ".255"
        for bcast in (subnet_bcast, "255.255.255.255"):
            print(f"probing from {local_ip} -> {bcast} ...", flush=True)
            host, addr = probe(local_ip, bcast)
            if host:
                print(f"FOUND via {local_ip}: {host} (responded from {addr})")
                found = True
                break

    if not found:
        print("No gateway responded on any interface.")
        sys.exit(1)


if __name__ == "__main__":
    main()
