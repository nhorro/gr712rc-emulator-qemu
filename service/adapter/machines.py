"""Static catalog of supported QEMU machine types and their metadata."""

MACHINES: dict[str, dict] = {
    "gr712rc": {
        "id": "gr712rc",
        "description": "GR712RC dual-core LEON3FT",
        "cpus": 2,
        "default_ram_mb": 64,
        "max_ram_mb": 1024,
        "uart_count": 5,
    },
    "gr740": {
        "id": "gr740",
        "description": "GR740 quad-core LEON4",
        "cpus": 4,
        "default_ram_mb": 256,
        "max_ram_mb": 2048,
        "uart_count": 1,
    },
}
