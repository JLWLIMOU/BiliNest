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
;   - **装过一次之后再运行安装包 = 更新**：先四处找有没有已存在的 BiliNest
;     （注册表 → 桌面快捷方式 → 常见安装位置 → 安装包自己所在目录），
;     找到就拿它的 package.json 读真实版本号，比本安装包新就直接更新：
;     装到**原目录**、跳过目录选择页、只替换程序文件，用户数据一概不动。
; =============================================================

; 这三个值允许用 ISCC 的 /D 覆盖（/DAppName=… /DAppId=… /DAppVersion=…）：
; 这样可以在不动用户真实安装的前提下，本地回归测试"新装 / 更新 / 降级"三种流程
; （见 tmp 里的探针脚本，发布用的正式编译不传任何 /D，取值就是下面这些）。
#ifndef AppName
  #define AppName "BiliNest"
#endif
#ifndef AppVersion
  #define AppVersion "1.4.4"
#endif
#ifndef AppId
  #define AppId "{{B1A9E4C2-7D3F-4A86-9C15-2E7B6F0A5D34}"
#endif
#define AppPublisher "JLWLIMOU"
#define AppUrl "https://github.com/JLWLIMOU/BiliNest"
#define SrcDir ".."

[Setup]
AppId={#AppId}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppUrl}
AppSupportURL={#AppUrl}
AppUpdatesURL={#AppUrl}
VersionInfoVersion=1.4.4.0
VersionInfoProductName={#AppName}
VersionInfoDescription={#AppName} 无干扰 B 站学习播放器 安装程序
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
; 更新（检测到已安装）时不显示目录选择页 —— 覆盖到别处就成了装第二份
DisableDirPage=auto
; 用上次装的位置作为默认目录（Inno 自带的行为，写出来是为了别被误改）
UsePreviousAppDir=yes
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
; 应用内自更新会把便携包里的这几个文件也铺进安装目录，卸载时一并清掉，别留尾巴
Type: filesandordirs; Name: "{app}\bin"
Type: files; Name: "{app}\start.sh"
Type: files; Name: "{app}\create-shortcut.ps1"

[Code]
const
  NodeMinMajor = 18;
  NodeUrl = 'https://nodejs.org/zh-cn/download';
  { Inno 给"当前用户安装"写的卸载信息键 —— 用它反查上次装在哪个目录。
    这里的 AppId 直接取自本脚本，免得两处手写 GUID 对不上。 }
  UninstallKey = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{#SetupSetting("AppId")}_is1';

var
  NodePage: TInputOptionWizardPage;
  NodeFound: Boolean;
  NodeOk: Boolean;
  NodeExe: String;
  NodeVersion: String;
  ExistingDir: String;      { 检测到的已安装副本目录（空 = 没装过） }
  ExistingVersion: String;  { 该副本的真实版本 —— 读 package.json，不信注册表里的旧记录 }
  GitCheckoutDir: String;   { 检测到源码检出（含 .git）：安装包不碰它，只提示一句 }
  UpdateMode: Boolean;      { 本次是"更新 / 重装"而不是"新装" }

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

{ ---------- 已有安装检测：决定这次是"新装"还是"更新" ---------- }

{ 目录像不像一份 BiliNest：至少得有启动器或服务端脚本 }
function LooksLikeBiliNest(const Dir: String): Boolean;
begin
  Result := (Dir <> '') and DirExists(Dir) and
            (FileExists(AddBackslash(Dir) + 'launcher.vbs') or
             FileExists(AddBackslash(Dir) + 'server.mjs'));
end;

{ 版本号里取第 Index 段（从 0 起）：'1.4.3' 的第 0/1/2 段分别是 1/4/3 }
function VerPart(const V: String; Index: Integer): Integer;
var
  I, Part, StartAt: Integer;
begin
  Result := 0;
  Part := 0;
  StartAt := 1;
  for I := 1 to Length(V) + 1 do
  begin
    if (I > Length(V)) or (V[I] = '.') then
    begin
      if Part = Index then
      begin
        Result := StrToIntDef(Copy(V, StartAt, I - StartAt), 0);
        Exit;
      end;
      Part := Part + 1;
      StartAt := I + 1;
    end;
  end;
end;

{ 比较两个 x.y.z 版本号：A 更新 → 1，一样 → 0，更旧 → -1 }
function CompareVer(const A, B: String): Integer;
var
  I, X, Y: Integer;
begin
  Result := 0;
  for I := 0 to 2 do
  begin
    X := VerPart(A, I);
    Y := VerPart(B, I);
    if X > Y then
    begin
      Result := 1;
      Exit;
    end;
    if X < Y then
    begin
      Result := -1;
      Exit;
    end;
  end;
end;

{ 读目录里 package.json 的 version —— 判断"装的是哪版"的唯一可信来源。
  为什么不看注册表里的 DisplayVersion：应用内更新只替换文件、不写注册表，
  那个值会滞后；文件里的版本才是真的。 }
function ReadDirVersion(const Dir: String): String;
var
  Lines: TArrayOfString;
  Line: String;
  I: Integer;
  P, Q: Integer;
begin
  Result := '';
  { 按行读：LoadStringFromFile 收的是 AnsiString，这里用 LoadStringsFromFile 更省事 }
  if not LoadStringsFromFile(AddBackslash(Dir) + 'package.json', Lines) then
    Exit;
  for I := 0 to GetArrayLength(Lines) - 1 do
  begin
    Line := Lines[I];
    P := Pos('"version"', Line);
    if P = 0 then Continue;
    Delete(Line, 1, P + 8);       { 跳过 "version" 这个词本身 }
    P := Pos(':', Line);
    if P = 0 then Continue;
    Delete(Line, 1, P);
    P := Pos('"', Line);
    if P = 0 then Continue;
    Delete(Line, 1, P);
    Q := Pos('"', Line);
    if Q = 0 then Continue;
    Result := Trim(Copy(Line, 1, Q - 1));
    if Result <> '' then Exit;
  end;
end;

{ 桌面快捷方式指向哪儿：便携版没有注册表记录，但多半有快捷方式 }
function DirFromShortcut(const LnkPath: String): String;
var
  Shell, Link: Variant;
  Target, Args, Script: String;
  P, Q: Integer;
begin
  Result := '';
  if not FileExists(LnkPath) then Exit;
  try
    Shell := CreateOleObject('WScript.Shell');
    Link := Shell.CreateShortcut(LnkPath);
    Target := Link.TargetPath;
    Args := Link.Arguments;
  except
    Exit;
  end;
  if (Pos('wscript.exe', Lowercase(Target)) > 0) or (Pos('cscript.exe', Lowercase(Target)) > 0) then
  begin
    { 快捷方式是 wscript.exe "…\launcher.vbs"：脚本路径在参数里 }
    P := Pos('"', Args);
    if P > 0 then
    begin
      Delete(Args, 1, P);
      Q := Pos('"', Args);
      if Q > 0 then Script := Copy(Args, 1, Q - 1);
    end
    else
      Script := Trim(Args);
    Result := ExtractFileDir(Script);
  end
  else
    Result := ExtractFileDir(Target);
end;

{ 记下一个候选目录：必须是真·BiliNest；版本更高的胜出（版本相同则保留先找到的） }
procedure ConsiderCandidate(const Dir: String);
var
  Ver: String;
begin
  if not LooksLikeBiliNest(Dir) then Exit;
  if DirExists(AddBackslash(Dir) + '.git') then
  begin
    { 源码检出（开发者自己 clone 的）：安装包不去覆盖它，更新走 git pull }
    if GitCheckoutDir = '' then GitCheckoutDir := Dir;
    Exit;
  end;
  Ver := ReadDirVersion(Dir);
  if (ExistingDir = '') or (CompareVer(Ver, ExistingVersion) > 0) then
  begin
    ExistingDir := Dir;
    ExistingVersion := Ver;
  end;
end;

{ 找一遍本机已有的 BiliNest：
    注册表（Inno 自己写的卸载信息）→ 桌面快捷方式 → 常见安装位置 → 安装包所在目录 }
procedure DetectExistingInstall();
var
  Dir: String;
begin
  ExistingDir := '';
  ExistingVersion := '';
  GitCheckoutDir := '';

  if RegQueryStringValue(HKCU, UninstallKey, 'InstallLocation', Dir) then ConsiderCandidate(Dir);
  if RegQueryStringValue(HKCU32, UninstallKey, 'InstallLocation', Dir) then ConsiderCandidate(Dir);
  if RegQueryStringValue(HKLM, UninstallKey, 'InstallLocation', Dir) then ConsiderCandidate(Dir);
  if RegQueryStringValue(HKLM32, UninstallKey, 'InstallLocation', Dir) then ConsiderCandidate(Dir);

  ConsiderCandidate(DirFromShortcut(ExpandConstant('{userdesktop}\{#AppName}.lnk')));
  ConsiderCandidate(DirFromShortcut(ExpandConstant('{commondesktop}\{#AppName}.lnk')));
  { 改名前的旧快捷方式，一并认一下 }
  ConsiderCandidate(DirFromShortcut(ExpandConstant('{userdesktop}\BiliPure.lnk')));
  ConsiderCandidate(DirFromShortcut(ExpandConstant('{commondesktop}\BiliPure.lnk')));

  ConsiderCandidate(ExpandConstant('{autopf}\{#AppName}'));
  ConsiderCandidate(ExpandConstant('{localappdata}\Programs\{#AppName}'));
  ConsiderCandidate(ExpandConstant('{commonpf}\{#AppName}'));
  ConsiderCandidate(ExpandConstant('{commonpf32}\{#AppName}'));
  { 安装包自己所在的目录：把 Setup 丢进便携版文件夹再运行，也算更新 }
  ConsiderCandidate(ExtractFileDir(ExpandConstant('{srcexe}')));

  if ExistingDir <> '' then
    Log(Format('已有安装检测：dir=%s version=%s', [ExistingDir, ExistingVersion]))
  else if GitCheckoutDir <> '' then
    Log('已有安装检测：只发现源码检出 ' + GitCheckoutDir + '（安装包不覆盖）')
  else
    Log('已有安装检测：本机没有已安装的 BiliNest');
end;

{ 安装开始前：先定下"新装 or 更新" }
function InitializeSetup(): Boolean;
var
  PkgVer: String;
  Cmp: Integer;
begin
  Result := True;
  UpdateMode := False;
  PkgVer := '{#AppVersion}';
  DetectExistingInstall();

  if ExistingDir = '' then
  begin
    { 只有源码检出时提一句，免得用户以为安装包"没认出"他的副本 }
    if (GitCheckoutDir <> '') and (not WizardSilent) then
      MsgBox('检测到源码检出（含 .git）：' + #13#10 + GitCheckoutDir + #13#10 + #13#10 +
             '安装包不会覆盖它。源码版更新请用 git pull，或在应用内"设置 → 关于 → 更新"。',
             mbInformation, MB_OK);
    Exit;
  end;

  Cmp := CompareVer(PkgVer, ExistingVersion);
  if Cmp > 0 then
  begin
    { 本安装包更新 → 更新模式：装到原目录，只换程序文件 }
    if not WizardSilent then
      MsgBox('检测到已安装 BiliNest v' + ExistingVersion + '：' + #13#10 + ExistingDir + #13#10 + #13#10 +
             '本次将更新到 v' + PkgVer + '（装回原目录、只替换程序文件）。' + #13#10 +
             '你的数据（登录态、视频库、收藏夹库、观看记录）在 %APPDATA%\BiliNest，不会被改动。',
             mbInformation, MB_OK);
    UpdateMode := True;
  end
  else if Cmp = 0 then
  begin
    { 同版本：问一句要不要修复式重装 }
    if WizardSilent then
      UpdateMode := True
    else if MsgBox('已经装过同样的版本 v' + ExistingVersion + '：' + #13#10 + ExistingDir + #13#10 + #13#10 +
                   '要重新安装一遍（把程序文件修回原样）吗？', mbConfirmation, MB_YESNO) = IDYES then
      UpdateMode := True
    else
      Result := False;
  end
  else
  begin
    { 已装的比本安装包还新：默认不降级 }
    if WizardSilent then
      Result := False
    else if MsgBox('已安装的版本更新：v' + ExistingVersion + '（本安装包是 v' + PkgVer + '）。' + #13#10 + #13#10 +
                   '确定要用这个较旧的版本覆盖吗？', mbConfirmation, MB_YESNO) = IDYES then
      UpdateMode := True
    else
      Result := False;
  end;
end;

{ ---------- 向导 ---------- }

procedure InitializeWizard();
begin
  { 更新模式：目录锁定为原安装位置（目录页会被跳过，这里把值也定死，
    免得用户从命令行带 /DIR 时跑到别处装出第二份） }
  if UpdateMode and (ExistingDir <> '') and (WizardForm <> nil) then
    WizardForm.DirEdit.Text := ExistingDir;
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
  Result := False;
  { 更新不是新装：装哪儿已经定了（原目录），不该让用户改 }
  if UpdateMode and (PageID = wpSelectDir) then
    Result := True;
  { Node.js 已就绪就不用问"怎么处理 Node" }
  if (NodePage <> nil) and (PageID = NodePage.ID) and NodeOk then
    Result := True;
end;

{ 目录页每次显示前再钉一次目标目录（命令行带 /DIR 也不该把更新装到别处） }
procedure CurPageChanged(CurPageID: Integer);
begin
  if UpdateMode and (ExistingDir <> '') and (CurPageID = wpSelectDir) and (WizardForm <> nil) then
    WizardForm.DirEdit.Text := ExistingDir;
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

  if UpdateMode then
    Result := '本次操作：更新 BiliNest v' + ExistingVersion + ' → v{#AppVersion}' + NewLine +
              '（装回原目录，只替换程序文件；用户数据不受影响）' + NewLine + NewLine + Result;

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

{
  换文件之前先让正在跑的本地服务退出：更新时它还在跑，新代码要重启才生效；
  顺带避免个别文件被占用导致替换失败。装完 [Run] 里的 launcher.vbs 会把它再拉起来。
}
procedure CurStepChanged(CurStep: TSetupStep);
var
  Mode: String;
begin
  if CurStep = ssInstall then
  begin
    if UpdateMode then Mode := '更新' else Mode := '新装';
    Log(Format('安装开始：%s，目标目录 %s', [Mode, WizardDirValue]));
    StopRunningService();
  end;
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
