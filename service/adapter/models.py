"""Pydantic models — drive both request validation and the OpenAPI schema."""

from datetime import datetime
from typing import Literal, Optional, Union

from pydantic import BaseModel, Field


class Machine(BaseModel):
    id: str
    description: str
    cpus: int
    default_ram_mb: int
    max_ram_mb: int
    uart_count: int


class CreateSessionRequest(BaseModel):
    machine: str
    kernel_url: str
    smp: Optional[int] = None
    ram_mb: Optional[int] = None


class Session(BaseModel):
    id: str
    machine: str
    status: Literal["created", "running", "paused", "exited"]
    smp: int
    kernel_url: str
    ram_mb: int
    created_at: datetime
    started_at: Optional[datetime] = None
    exit_code: Union[int, str, None] = None


class Upload(BaseModel):
    kernel_url: str
    filename: str
    size: int
    uploaded_at: datetime


class MemoryResponse(BaseModel):
    addr: str
    size: int
    data: str


class ErrorResponse(BaseModel):
    error: str
    message: str
    details: dict = Field(default_factory=dict)
