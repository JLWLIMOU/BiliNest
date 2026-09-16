' BiliNest 流量报告 —— 桌面快捷方式指向本文件。
' 双击后：静默跑一次 tools\traffic.mjs（不弹控制台窗口），生成 HTML 报告并打开。
Option Explicit
Dim sh, fso, here, root, cmd
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)   ' tools\
root = fso.GetParentFolderName(here)                     ' 仓库根目录
sh.CurrentDirectory = root
cmd = "node """ & root & "\tools\traffic.mjs"" --html --open"
sh.Run cmd, 0, False
