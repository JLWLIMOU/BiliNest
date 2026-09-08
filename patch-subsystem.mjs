#!/usr/bin/env node
/**
 * PE 子系统补丁：把 exe 从 Console(CUI=3) 改为 GUI(2)，
 * Windows 就不会分配控制台窗口。
 * 用法：node patch-subsystem.mjs <exe路径>
 */
import fs from 'node:fs';
const exe = process.argv[2];
if (!exe) { console.error('Usage: node patch-subsystem.mjs <exe>'); process.exit(1); }
const buf = fs.readFileSync(exe);
const peOffset = buf.readUInt32LE(0x3C);
const subOffset = peOffset + 4 + 20 + 68; // PE sig + COFF + OptionalHeader subsystem
const current = buf.readUInt16LE(subOffset);
console.log(`PE subsystem: ${current} (${current === 3 ? 'CUI' : current === 2 ? 'GUI' : 'other'})`);
if (current === 3) {
  buf.writeUInt16LE(0x02, subOffset);
  fs.writeFileSync(exe, buf);
  console.log('Patched to GUI (2). No console window.');
} else {
  console.log('Already GUI or unknown. Skipped.');
}
