; =============================================================
;  BiliNest 安装包脚本（Inno Setup 6）
;  ------------------------------------------------------------
;  编译：  installer\build.ps1
;  产物：  dist\BiliNest-<版本>-Setup.exe
;
;  设计要点：
;   - 本体是「本地 Node 服务 + 纯前端」，安装包只铺文件、建快捷方式；
;   - Node.js **不自带**（不为一个运行时白胖 87MB）：安装时**只检测**（读文件
;     版本资源 + 注册表，不启动任何进程），缺失就给「打开下载页 / 跳过」二选一
;     —— 安装包自己绝不下载或执行任何东西（旧版会写临时 .bat + winget 安装，
;     实测被火绒按木马启发式拦下）；
;   - 默认装进当前用户目录（%LOCALAPPDATA%\Programs\BiliNest），
;     不动注册表的机器级设置、不要管理员权限；安装位置可在向导里改；
;   - 卸载时问一句：是否连用户数据（%APPDATA%\BiliNest）一起删。
; =============================================================

#define AppName "BiliNest"
#define AppVersion "1.4.1"
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
VersionInfoVersion=1.4.1.0
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

; 安装包里不再附带 create-shortcut.ps1（安装向导自己会建快捷方式），
; 少一个"创建快捷方式的 PowerShell 脚本"躺在安装目录里，也少一点被误报的理由。

[InstallDelete]
; 升级时先清掉旧前端文件，避免改名/删掉的资源残留
Type: filesandordirs; Name: "{app}\public"

[Files]
Source: "{#SrcDir}\server.mjs"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SrcDir}\launcher.vbs"; DestDir: "{app}"; Flags: ignoreversion
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

{ 读 node.exe 里的版本资源，抠出版本号。

  **只读文件，不执行任何进程** —— 这里原来会往临时目录写一个 .bat、再用
  cmd 执行它去跑 "node -v"。"安装包往 %TEMP% 写脚本并执行" 是最典型的木马
  启发式特征（实测火绒会把安装包直接报成木马），而且读版本资源本来就能拿到
  同样的信息，没有任何理由去起进程。 }
function ProbeNode(const Exe: String; var Version: String): Boolean;
var
  Raw: String;
begin
  Result := False;
  Version := '';
  if (Exe = '') or (not FileExists(Exe)) then
    Exit;
  if GetVersionNumbersString(Exe, Raw) then
  begin
    Version := ExtractVersion(Raw);
    Result := Version <> '';
  end;
end;

{ 收集候选路径：PATH 里找到的 + 注册表记的 + 几个常见安装位置 }
procedure AddNodeCandidate(var List: TArrayOfString; var Count: Integer; const Path: String);
begin
  if (Path = '') or (Count >= GetArrayLength(List)) then
    Exit;
  List[Count] := Path;
  Count := Count + 1;
end;

{ 探测 Node.js：只查文件和注册表，不启动任何进程（见 ProbeNode 的说明） }
procedure DetectNode();
var
  Candidates: TArrayOfString;
  Count, I, Major: Integer;
  Ver, RegPath: String;
begin
  NodeFound := False;
  NodeOk := False;
  NodeExe := '';
  NodeVersion := '';

  SetLength(Candidates, 8);
  Count := 0;
  { FileSearch 只在 PATH 的各个目录里找文件，不会执行它 }
  AddNodeCandidate(Candidates, Count, FileSearch('node.exe', GetEnv('PATH')));
  if RegQueryStringValue(HKLM, 'SOFTWARE\Node.js', 'InstallPath', RegPath) then
    AddNodeCandidate(Candidates, Count, RegPath + '\node.exe');
  if RegQueryStringValue(HKLM32, 'SOFTWARE\Node.js', 'InstallPath', RegPath) then
    AddNodeCandidate(Candidates, Count, RegPath + '\node.exe');
  if RegQueryStringValue(HKCU, 'SOFTWARE\Node.js', 'InstallPath', RegPath) then
    AddNodeCandidate(Candidates, Count, RegPath + '\node.exe');
  AddNodeCandidate(Candidates, Count, GetEnv('ProgramW6432') + '\nodejs\node.exe');
  AddNodeCandidate(Candidates, Count, GetEnv('ProgramFiles') + '\nodejs\node.exe');
  AddNodeCandidate(Candidates, Count, GetEnv('ProgramFiles(x86)') + '\nodejs\node.exe');
  AddNodeCandidate(Candidates, Count, GetEnv('LOCALAPPDATA') + '\Programs\nodejs\node.exe');

  for I := 0 to Count - 1 do
  begin
    if not ProbeNode(Candidates[I], Ver) then
      Continue;
    { 记住第一个找到的（用于提示"版本过低"），但优先挑版本够用的 }
    if not NodeFound then
    begin
      NodeFound := True;
      NodeExe := Candidates[I];
      NodeVersion := Ver;
    end;
    Major := StrToIntDef(Copy(Ver, 1, Pos('.', Ver) - 1), 0);
    if Major >= NodeMinMajor then
    begin
      NodeOk := True;
      NodeExe := Candidates[I];
      NodeVersion := Ver;
      Log(Format('Node 探测：ok version=%s exe=%s', [NodeVersion, NodeExe]));
      Exit;
    end;
  end;
  if NodeFound then
    Log(Format('Node 探测：版本过低 version=%s exe=%s', [NodeVersion, NodeExe]))
  else
    Log('Node 探测：未找到 Node.js');
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
  NodePage.Add('打开 nodejs.org 下载页，我自己安装（推荐）');
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
    { 安装包自己不下载、不执行任何东西：只开浏览器打开下载页 }
    ShellExec('open', NodeUrl, '', '', SW_SHOWNORMAL, ewNoWait, Code);
    if MsgBox('装好 Node.js 之后回到这里继续。' + #13#10 + #13#10 +
              '点「确定」重新检测一次（不用重开安装包）；点「取消」先继续安装 —— ' +
              '装好后双击快捷方式会看到安装指引。',
              mbConfirmation, MB_OKCANCEL) = IDOK then
      DetectNode();
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
