; =============================================================
;  BiliNest 安装包脚本（Inno Setup 6）
;  ------------------------------------------------------------
;  编译：  installer\build.ps1
;  产物：  dist\BiliNest-<版本>-Setup.exe
;
;  设计要点：
;   - 本体是「本地 Node 服务 + 纯前端」，安装包只铺文件、建快捷方式；
;   - Node.js **不自带**（不为一个运行时白胖 87MB）：安装时检测，
;     缺失就给「winget 安装 / 官网下载 / 跳过」三选一；
;   - 默认装进当前用户目录（%LOCALAPPDATA%\Programs\BiliNest），
;     不动注册表的机器级设置、不要管理员权限；安装位置可在向导里改；
;   - 卸载时问一句：是否连用户数据（%APPDATA%\BiliNest）一起删。
; =============================================================

#define AppName "BiliNest"
#define AppVersion "1.2.2"
#define AppPublisher "JLWLIMOU"
#define AppUrl "https://github.com/JLWLIMOU/BiliNest"
#define SrcDir ".."

[Setup]
AppId={{B1A9E4C2-7D3F-4A86-9C15-2E7B6F0A5D34}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppUrl}
AppSupportURL={#AppUrl}
AppUpdatesURL={#AppUrl}
VersionInfoVersion=1.2.2.0
VersionInfoProductName={#AppName}
VersionInfoDescription={#AppName} 无干扰 B 站学习播放器 安装程序
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
AllowNoIcons=yes
PrivilegesRequired=lowest
OutputDir={#SrcDir}\dist
OutputBaseFilename={#AppName}-{#AppVersion}-Setup
SetupIconFile={#SrcDir}\public\icon.ico
UninstallDisplayIcon={app}\public\icon.ico
UninstallDisplayName={#AppName}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern

[Languages]
Name: "chinese"; MessagesFile: "{#SourcePath}\languages\ChineseSimplified.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[InstallDelete]
; 升级时先清掉旧前端文件，避免改名/删掉的资源残留
Type: filesandordirs; Name: "{app}\public"

[Files]
Source: "{#SrcDir}\server.mjs"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SrcDir}\launcher.vbs"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SrcDir}\create-shortcut.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SrcDir}\package.json"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SrcDir}\README.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SrcDir}\CHANGELOG.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SrcDir}\LICENSE"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SrcDir}\.env.example"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SrcDir}\public\*"; DestDir: "{app}\public"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#AppName}"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\launcher.vbs"""; WorkingDir: "{app}"; IconFilename: "{app}\public\icon.ico"; Comment: "无干扰 B 站学习播放器"
Name: "{group}\{cm:UninstallProgram,{#AppName}}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\launcher.vbs"""; WorkingDir: "{app}"; IconFilename: "{app}\public\icon.ico"; Comment: "无干扰 B 站学习播放器"; Tasks: desktopicon

[Run]
Filename: "{sys}\wscript.exe"; Parameters: """{app}\launcher.vbs"""; WorkingDir: "{app}"; Description: "{cm:LaunchProgram,{#AppName}}"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
Type: files; Name: "{app}\bilinest.port"
Type: files; Name: "{app}\bilinest.log"
Type: filesandordirs; Name: "{app}\public"

[Code]
const
  NodeMinMajor = 18;
  NodeUrl = 'https://nodejs.org/zh-cn/download';

var
  NodePage: TInputOptionWizardPage;
  NodeFound: Boolean;
  NodeOk: Boolean;
  NodeExe: String;
  NodeVersion: String;

{ ---------- 工具函数 ---------- }

{ 从 "v22.14.0" 之类的文本里抠出版本号 }
function ExtractVersion(const S: String): String;
var
  I, J: Integer;
begin
  Result := '';
  I := 1;
  while I <= Length(S) do
  begin
    if (S[I] >= '0') and (S[I] <= '9') then
    begin
      J := I;
      while (J <= Length(S)) and
            (((S[J] >= '0') and (S[J] <= '9')) or (S[J] = '.')) do
        J := J + 1;
      Result := Copy(S, I, J - I);
      if Pos('.', Result) > 0 then
        Exit;
    end;
    I := I + 1;
  end;
end;

{ 探测某个 node 能否跑起来，并抠出版本号。
  特意先写出一个临时 .bat 再执行，而不是直接 "cmd /C ..."：
  cmd /C 后面同时出现引号包裹的路径和 ">" 重定向时，cmd 会把最外层
  引号剥掉，"C:\Program Files\..." 这种带空格的路径就执行失败了
  （第一版就栽在这里，所有候选路径全军覆没、误报"没装 Node"）。 }
function ProbeNode(const Exe: String; var Version: String): Boolean;
var
  BatFile, OutFile, Text: String;
  Code: Integer;
  Lines: TArrayOfString;
  I: Integer;
begin
  Result := False;
  Version := '';
  BatFile := ExpandConstant('{tmp}\bilinest-nodecheck.bat');
  OutFile := ExpandConstant('{tmp}\bilinest-nodever.txt');
  if FileExists(OutFile) then
    DeleteFile(OutFile);
  Text := '@echo off' + #13#10 + '"' + Exe + '" -v > "' + OutFile + '" 2>&1' + #13#10;
  if not SaveStringToFile(BatFile, Text, False) then
  begin
    Log('Node 探测：无法写出探测脚本 ' + BatFile);
    Exit;
  end;
  if not Exec(BatFile, '', '', SW_HIDE, ewWaitUntilTerminated, Code) then
  begin
    Log('Node 探测：执行探测脚本失败 ' + BatFile);
    Exit;
  end;
  if not FileExists(OutFile) then
    Exit;
  if not LoadStringsFromFile(OutFile, Lines) then
    Exit;
  Text := '';
  for I := 0 to GetArrayLength(Lines) - 1 do
    if Trim(Lines[I]) <> '' then
      Text := Text + Trim(Lines[I]) + ' ';
  Version := ExtractVersion(Trim(Text));
  Result := Version <> '';
end;

{ 探测 Node.js：先看 PATH，再看几个常见安装位置（与 launcher.vbs 一致） }
procedure DetectNode();
var
  Candidates: TArrayOfString;
  I: Integer;
  Out1: String;
begin
  NodeFound := False;
  NodeOk := False;
  NodeExe := '';
  NodeVersion := '';

  SetLength(Candidates, 5);
  Candidates[0] := 'node';                                    { 交给 PATH 解析 }
  Candidates[1] := GetEnv('ProgramW6432') + '\nodejs\node.exe';
  Candidates[2] := GetEnv('ProgramFiles') + '\nodejs\node.exe';
  Candidates[3] := GetEnv('ProgramFiles(x86)') + '\nodejs\node.exe';
  Candidates[4] := GetEnv('LOCALAPPDATA') + '\Programs\nodejs\node.exe';

  for I := 0 to GetArrayLength(Candidates) - 1 do
  begin
    if (Candidates[I] = 'node') or FileExists(Candidates[I]) then
    begin
      if ProbeNode(Candidates[I], Out1) then
      begin
        NodeVersion := Out1;
        if NodeVersion <> '' then
        begin
          NodeFound := True;
          NodeExe := Candidates[I];
          NodeOk := StrToIntDef(Copy(NodeVersion, 1, Pos('.', NodeVersion) - 1), 0) >= NodeMinMajor;
          { 注意：这一行不能拆成以 "[" 开头的续行——Inno 会把行首的 [ 当成新段标签 }
          Log(Format('Node 探测：found ok=%d version=%s exe=%s', [Ord(NodeOk), NodeVersion, NodeExe]));
          Exit;
        end;
      end;
    end;
  end;
  Log('Node 探测：未找到可用的 Node.js');
end;

function NodePageSubCaption(): String;
begin
  if NodeOk then
    Result := '已检测到 Node.js ' + NodeVersion + '，无需额外操作。'
  else if NodeFound then
    Result := '检测到 Node.js ' + NodeVersion + '，但 BiliNest 需要 ' + IntToStr(NodeMinMajor) +
              ' 或更高版本，请先升级。'
  else
    Result := '系统里没找到 Node.js。BiliNest 的本地服务由它驱动，' +
              '需要 ' + IntToStr(NodeMinMajor) + ' 或更高版本。';
end;

{ ---------- 向导 ---------- }

procedure InitializeWizard();
begin
  DetectNode();
  NodePage := CreateInputOptionPage(wpSelectTasks,
    '运行环境检查', '选择如何处理 Node.js', NodePageSubCaption(), True, False);
  NodePage.Add('用 winget 自动安装 Node.js LTS（推荐）');
  NodePage.Add('打开 nodejs.org 下载页，我自己安装');
  NodePage.Add('先跳过（我稍后自己装）');
  NodePage.Values[0] := True;
  if NodeOk then
    NodePage.Values[0] := False;
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := (NodePage <> nil) and (PageID = NodePage.ID) and NodeOk;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  Code: Integer;
begin
  Result := True;
  if (NodePage = nil) or (CurPageID <> NodePage.ID) or NodeOk then
    Exit;

  if NodePage.Values[0] then
  begin
    { winget 安装：可见窗口，方便用户看到进度与可能的权限提示 }
    if MsgBox('将调用 winget 安装 Node.js LTS。' + #13#10 + #13#10 +
              '过程中可能弹出系统权限提示，属正常现象。是否继续？',
              mbConfirmation, MB_YESNO) <> IDYES then
    begin
      Result := False;
      Exit;
    end;
    WizardForm.NextButton.Enabled := False;
    try
      Exec(ExpandConstant('{cmd}'),
           '/K "winget install --id OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements && echo. && echo 安装结束，按任意键继续... && pause > nul"',
           '', SW_SHOW, ewWaitUntilTerminated, Code);
    finally
      WizardForm.NextButton.Enabled := True;
    end;
    DetectNode();
    if not NodeOk then
    begin
      if MsgBox('仍未检测到可用的 Node.js。' + #13#10 + #13#10 +
                '可以再试一次，或者先继续安装 BiliNest —— ' +
                '装好后双击快捷方式会打开一份安装指引。' + #13#10 + #13#10 +
                '是否仍要继续安装？', mbConfirmation, MB_YESNO) <> IDYES then
        Result := False;
    end;
  end
  else if NodePage.Values[1] then
  begin
    ShellExec('open', NodeUrl, '', '', SW_SHOWNORMAL, ewNoWait, Code);
  end;
end;

function UpdateReadyMemo(Space, NewLine, MemoUserInfoInfo, MemoDirInfo, MemoTypeInfo,
  MemoComponentsInfo, MemoGroupInfo, MemoTasksInfo: String): String;
begin
  Result := MemoDirInfo + NewLine + NewLine;
  if MemoTasksInfo <> '' then
    Result := Result + MemoTasksInfo + NewLine + NewLine;

  if NodeOk then
    Result := Result + '运行环境：已检测到 Node.js ' + NodeVersion + NewLine +
              '　　　　　' + NodeExe + NewLine
  else if NodeFound then
    Result := Result + '运行环境：Node.js ' + NodeVersion + ' 版本过低（需要 ' +
              IntToStr(NodeMinMajor) + '+）' + NewLine
  else
    Result := Result + '运行环境：未检测到 Node.js，装好后需要先安装它才能启动' + NewLine;
end;

{ ---------- 卸载 ---------- }

{ 让正在跑的本地服务先退出（读 bilinest.port 找到端口，调用 /api/shutdown） }
procedure StopRunningService();
var
  PortFile: String;
  Lines: TArrayOfString;
  Port: String;
  Http: Variant;
begin
  PortFile := ExpandConstant('{app}\bilinest.port');
  if not FileExists(PortFile) then
    Exit;
  if not LoadStringsFromFile(PortFile, Lines) then
    Exit;
  if GetArrayLength(Lines) = 0 then
    Exit;
  Port := Trim(Lines[0]);
  if Port = '' then
    Exit;
  try
    Http := CreateOleObject('WinHttp.WinHttpRequest.5.1');
    Http.Open('GET', 'http://127.0.0.1:' + Port + '/api/shutdown', False);
    Http.SetTimeouts(1000, 1000, 1000, 2000);
    Http.Send();
  except
    { 服务没在跑就算了 }
  end;
  Sleep(900);
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  DataDir: String;
begin
  if CurUninstallStep = usUninstall then
  begin
    StopRunningService();
    DataDir := ExpandConstant('{userappdata}\BiliNest');
    if DirExists(DataDir) then
    begin
      { 用 SuppressibleMsgBox：/SILENT、/VERYSILENT 下不会被这个弹窗卡住，直接取默认值「否」（保留数据） }
      if SuppressibleMsgBox('是否同时删除用户数据？' + #13#10 + #13#10 +
                DataDir + #13#10 + #13#10 +
                '里面是登录凭据、视频库、收藏夹库、自定义标签页、观看记录与自动备份。' +
                '选择「否」则保留，重新安装后还能接着用。',
                mbConfirmation, MB_YESNO, IDNO) = IDYES then
        DelTree(DataDir, True, True, True);
    end;
  end;
end;
