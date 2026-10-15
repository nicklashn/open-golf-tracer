; Open Golf Tracer - Windows installer (Inno Setup 6). Build it with installer\build.ps1, which
; prepares installer\build\stage (code, built web app, node_modules, portable Node, Python and FFmpeg)
; and passes the version: ISCC /DAppVersion=0.1.0 OpenGolfTracer.iss
;
; Installs per user in %LOCALAPPDATA%\Programs (no admin rights). Python itself is bundled, but the
; Python packages (PyTorch with CUDA on NVIDIA cards, the ball detector weights) are several GB, so
; prepare.cmd downloads them at the end of the installation, behind a progress page (see [Code]).

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#define AppName "Open Golf Tracer"
#define Stage "build\stage"

[Setup]
AppId={{6F0B8C2A-4D7E-4B19-9A55-3E1C7D2F8A41}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppName}
AppPublisherURL=https://github.com/nicklashn/open-golf-tracer
DefaultDirName={localappdata}\Programs\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.17763
OutputDir=dist
OutputBaseFilename=OpenGolfTracer-Setup-{#AppVersion}
SetupIconFile={#Stage}\apps\web\public\favicon.ico
UninstallDisplayIcon={app}\apps\web\public\favicon.ico
UninstallDisplayName={#AppName}
LicenseFile={#Stage}\LICENSE
WizardStyle=modern
Compression=lzma2/max
SolidCompression=yes
LZMAUseSeparateProcess=yes
; The Python environment downloaded after the installation (CUDA PyTorch) takes about 6 GB.
ExtraDiskSpaceRequired=6442450944
CloseApplications=yes
ShowLanguageDialog=auto

[Languages]
Name: "en"; MessagesFile: "compiler:Default.isl"
Name: "da"; MessagesFile: "compiler:Languages\Danish.isl"

[CustomMessages]
en.LaunchApp=Start Open Golf Tracer now
da.LaunchApp=Start Open Golf Tracer nu
en.DeleteData=Also delete your projects, videos and exports?%n%nChoose No to keep them for a later installation.
da.DeleteData=Skal dine projekter, videoer og eksporter også slettes?%n%nVælg Nej for at beholde dem til en senere installation.

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[InstallDelete]
; An update replaces the code completely so no stale files survive. data\ (projects, videos) and
; .venv (the Python environment, reused to make updates quick) are kept.
Type: filesandordirs; Name: "{app}\apps"
Type: filesandordirs; Name: "{app}\packages"
Type: filesandordirs; Name: "{app}\shottracer"
Type: filesandordirs; Name: "{app}\scripts"
Type: filesandordirs; Name: "{app}\assets"
Type: filesandordirs; Name: "{app}\node_modules"
Type: filesandordirs; Name: "{app}\runtime\node"
Type: filesandordirs; Name: "{app}\runtime\ffmpeg"
Type: filesandordirs; Name: "{app}\runtime\uv"
Type: filesandordirs; Name: "{app}\runtime\uv-cache"
Type: filesandordirs; Name: "{app}\runtime\python"
Type: files; Name: "{app}\.venv\.ready"

[Files]
Source: "{#Stage}\*"; DestDir: "{app}"; Excludes: "\installer,\data,\.github,\videos,\setup.bat,\setup.sh,\start.bat,\.env"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#Stage}\.env.example"; DestDir: "{app}"; DestName: ".env"; Flags: onlyifdoesntexist
Source: "files\OpenGolfTracer.cmd"; DestDir: "{app}"; Flags: ignoreversion
Source: "files\prepare.cmd"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\OpenGolfTracer.cmd"; WorkingDir: "{app}"; IconFilename: "{app}\apps\web\public\favicon.ico"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\OpenGolfTracer.cmd"; WorkingDir: "{app}"; IconFilename: "{app}\apps\web\public\favicon.ico"; Tasks: desktopicon

[Run]
Filename: "{app}\OpenGolfTracer.cmd"; WorkingDir: "{app}"; Description: "{cm:LaunchApp}"; Flags: postinstall nowait skipifsilent shellexec

[UninstallDelete]
; Created after the installation (Python environment, caches, generated files).
Type: filesandordirs; Name: "{app}\.venv"
Type: filesandordirs; Name: "{app}\runtime"
Type: filesandordirs; Name: "{app}\apps"
Type: filesandordirs; Name: "{app}\packages"
Type: filesandordirs; Name: "{app}\shottracer"
Type: filesandordirs; Name: "{app}\scripts"
Type: filesandordirs; Name: "{app}\node_modules"

[Code]
var
  PreparePage: TOutputMarqueeProgressPage;

procedure InitializeWizard;
begin
  PreparePage := CreateOutputMarqueeProgressPage(CustomMessage('PrepareTitle'), CustomMessage('PrepareDesc'));
end;

function ReadFirstLine(const FileName: String): String;
var
  S: AnsiString;
begin
  Result := '';
  if LoadStringFromFile(FileName, S) then
    Result := Trim(String(S));
end;

{ Runs prepare.cmd hidden and shows its current step (runtime\setup-status.txt) until it writes
  runtime\setup-result.txt. The details go to runtime\setup.log instead of a console window. }
procedure RunPrepare;
var
  Dir, Step, Res: String;
  Code, Waited: Integer;
begin
  Dir := ExpandConstant('{app}');
  DeleteFile(Dir + '\runtime\setup-status.txt');
  DeleteFile(Dir + '\runtime\setup-result.txt');
  if not Exec(ExpandConstant('{cmd}'), '/c ""' + Dir + '\prepare.cmd" /hidden"', Dir, SW_HIDE, ewNoWait, Code) then
    Exit;
  PreparePage.SetText(CustomMessage('PrepareStep1'), CustomMessage('PrepareHint'));
  PreparePage.Show;
  try
    Res := '';
    Waited := 0;
    { Give up waiting after 3 hours; the app shortcut finishes the job then. }
    while (Res = '') and (Waited < 3 * 60 * 60 * 1000) do
    begin
      Step := ReadFirstLine(Dir + '\runtime\setup-status.txt');
      if (Step = '2') or (Step = '3') or (Step = '4') then
        PreparePage.SetText(CustomMessage('PrepareStep' + Step), CustomMessage('PrepareHint'));
      PreparePage.Animate;
      Sleep(100);
      Waited := Waited + 100;
      Res := ReadFirstLine(Dir + '\runtime\setup-result.txt');
    end;
  finally
    PreparePage.Hide;
  end;
  if (Res <> 'ok') and not WizardSilent then
    MsgBox(FmtMessage(CustomMessage('PrepareFailed'), [Dir + '\runtime\setup.log']), mbInformation, MB_OK);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
    RunPrepare;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if (CurUninstallStep = usUninstall) and DirExists(ExpandConstant('{app}\data')) and not UninstallSilent then
    if MsgBox(CustomMessage('DeleteData'), mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES then
      DelTree(ExpandConstant('{app}\data'), True, True, True);
  if CurUninstallStep = usPostUninstall then
    RemoveDir(ExpandConstant('{app}'));
end;
