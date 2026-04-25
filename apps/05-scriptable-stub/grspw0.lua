-- grspw0.lua — minimal scriptable-device stub for issue #4 prototype
--
-- Implements a tiny register file:
--   offset 0x000  scratch  (read/write, default 0)
--   offset 0x004  status   (read-only, returns 0xCAFE0000)
--   offset 0x010  trigger  (write any value -> pulse IRQ 12)
--   anything else read 0, writes ignored
--
-- The `sim` table is provided by QEMU.

local SCRATCH  = 0x000
local STATUS   = 0x004
local TRIGGER  = 0x010
local STATUS_V = 0xCAFE0000
local IRQ_LINE = 12

local regs = { [SCRATCH] = 0 }

function init()
    sim.log(string.format("grspw0.lua loaded at t=%d ns", sim.time_ns()))
end

function read(offset, size)
    if offset == STATUS then
        return STATUS_V
    end
    return regs[offset] or 0
end

function write(offset, size, value)
    if offset == SCRATCH then
        regs[SCRATCH] = value
        sim.log(string.format("scratch <- 0x%08x", value))
    elseif offset == TRIGGER then
        sim.log(string.format("trigger -> pulse IRQ %d", IRQ_LINE))
        sim.irq_raise(IRQ_LINE)
        sim.irq_lower(IRQ_LINE)
    else
        sim.log(string.format("ignore write off=0x%03x val=0x%x", offset, value))
    end
end
