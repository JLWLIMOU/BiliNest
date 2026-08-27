' ============================================================
' BiliPure Launcher
' ------------------------------------------------------------
' 1. Check whether the local proxy is already running;
' 2. If not, start "node server.mjs" in a hidden window;
' 3. Wait until the service is ready, then open the browser.
' 若默认端口 4173 被其它程序占用，server.mjs 会自动顺延到下一个
' 空闲端口，并把最终端口写入 bilipure.port，本脚本据此打开正确地址。
' ============================================================
Option Explicit

Const DEF_PORT = 4173
Const PORT_FILE = "bilipure.port"
Const MAX_WAIT = 40   ' 40 x 500ms = 最多等待 20 秒

Dim fso, scriptDir, shell
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = scriptDir

' 1) 默认端口上已在运行？直接打开
If HealthOk(DEF_PORT) Then
  OpenBrowser DEF_PORT
  WScript.Quit
End If

' 2) 上次运行顺延过端口？若该端口上确实是 BiliPure，直接打开
Dim lastPort
lastPort = ReadPortFile()
If lastPort > 0 And lastPort <> DEF_PORT Then
  If HealthOk(lastPort) Then
    OpenBrowser lastPort
    WScript.Quit
  End If
End If

' 3) 启动前清掉旧的端口文件，避免读到上一次的残留
Dim portFilePath
portFilePath = fso.BuildPath(scriptDir, PORT_FILE)
If fso.FileExists(portFilePath) Then fso.DeleteFile portFilePath

' 4) 启动本地代理（窗口样式 0 = 隐藏，不等待）
shell.Run "node server.mjs", 0, False

' 5) 轮询等待服务就绪：优先读端口文件，兜底检查默认端口
Dim i, p
For i = 1 To MAX_WAIT
  WScript.Sleep 500
  p = ReadPortFile()
  If p > 0 Then
    If HealthOk(p) Then
      OpenBrowser p
      WScript.Quit
    End If
  ElseIf HealthOk(DEF_PORT) Then
    OpenBrowser DEF_PORT
    WScript.Quit
  End If
Next

' 6) 超时兜底：按端口文件或默认端口最后再试一次
p = ReadPortFile()
If p > 0 And HealthOk(p) Then
  OpenBrowser p
Else
  OpenBrowser DEF_PORT
End If
WScript.Quit

' ------------------------------------------------------------
' 读取 bilipure.port（纯数字文本），失败返回 0
' ------------------------------------------------------------
Function ReadPortFile()
  On Error Resume Next
  Dim f, s, p
  ReadPortFile = 0
  p = fso.BuildPath(scriptDir, PORT_FILE)
  If fso.FileExists(p) Then
    Set f = fso.OpenTextFile(p, 1, False, -2)
    s = Trim(f.ReadAll)
    f.Close
    If IsNumeric(s) Then ReadPortFile = CInt(s)
  End If
  On Error GoTo 0
End Function

' ------------------------------------------------------------
' 健康检查：确认 /api/health 返回且响应里确实有 "bilipure"
' （防止 4173 被别的程序占用时，误打开别人的页面）
' ------------------------------------------------------------
Function HealthOk(port)
  On Error Resume Next
  Dim xml
  Set xml = CreateObject("MSXML2.ServerXMLHTTP.6.0")
  If IsObject(xml) Then
    xml.Open "GET", "http://127.0.0.1:" & port & "/api/health", False
    xml.setTimeouts 800, 800, 800, 2000
    xml.Send
    HealthOk = (xml.Status = 200) And (InStr(xml.responseText, "bilipure") > 0)
    Set xml = Nothing
  Else
    HealthOk = False
  End If
  On Error GoTo 0
End Function

' ------------------------------------------------------------
' 打开 BiliPure
' ------------------------------------------------------------
Sub OpenBrowser(port)
  Dim s
  Set s = CreateObject("WScript.Shell")
  s.Run "http://127.0.0.1:" & port, 1, False
End Sub
