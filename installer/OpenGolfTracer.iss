; Open Golf Tracer - Windows installer (Inno Setup 6). Build it with installer\build.ps1, which
; prepares installer\build\stage (code, built web app, node_modules, portable Node, Python with all
; packages, FFmpeg and the ball detector) and passes the version: ISCC /DAppVersion=0.2.0 OpenGolfTracer.iss
;
; Installs per user in %LOCALAPPDATA%\Programs (no admin rights). Everything is in the installer:
; the ball detector runs as ONNX with ONNX Runtime (DirectML on any GPU), so nothing is downloaded.

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
; An update replaces the code and runtimes completely so no stale files survive; data\ (projects,
; videos) is kept. .venv and prepare.cmd are left over from 0.1.x, which downloaded PyTorch (~5 GB).
Type: filesandordirs; Name: "{app}\apps"
Type: filesandordirs; Name: "{app}\packages"
Type: filesandordirs; Name: "{app}\shottracer"
Type: filesandordirs; Name: "{app}\scripts"
Type: filesandordirs; Name: "{app}\assets"
Type: filesandordirs; Name: "{app}\models"
Type: filesandordirs; Name: "{app}\node_modules"
Type: filesandordirs; Name: "{app}\runtime"
Type: filesandordirs; Name: "{app}\.venv"
Type: files; Name: "{app}\prepare.cmd"

[Files]
Source: "{#Stage}\*"; DestDir: "{app}"; Excludes: "\installer,\data,\.github,\videos,\setup.bat,\setup.sh,\start.bat,\.env"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#Stage}\.env.example"; DestDir: "{app}"; DestName: ".env"; Flags: onlyifdoesntexist
Source: "files\OpenGolfTracer.cmd"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\OpenGolfTracer.cmd"; WorkingDir: "{app}"; IconFilename: "{app}\apps\web\public\favicon.ico"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\OpenGolfTracer.cmd"; WorkingDir: "{app}"; IconFilename: "{app}\apps\web\public\favicon.ico"; Tasks: desktopicon

[Run]
Filename: "{app}\OpenGolfTracer.cmd"; WorkingDir: "{app}"; Description: "{cm:LaunchApp}"; Flags: postinstall nowait skipifsilent shellexec

[UninstallDelete]
; Created while the app runs (Python caches, numba caches) or left over from 0.1.x.
Type: filesandordirs; Name: "{app}\runtime"
Type: filesandordirs; Name: "{app}\apps"
Type: filesandordirs; Name: "{app}\packages"
Type: filesandordirs; Name: "{app}\shottracer"
Type: filesandordirs; Name: "{app}\scripts"
Type: filesandordirs; Name: "{app}\node_modules"
Type: filesandordirs; Name: "{app}\.venv"

[Code]
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if (CurUninstallStep = usUninstall) and DirExists(ExpandConstant('{app}\data')) and not UninstallSilent then
    if MsgBox(CustomMessage('DeleteData'), mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES then
      DelTree(ExpandConstant('{app}\data'), True, True, True);
  if CurUninstallStep = usPostUninstall then
    RemoveDir(ExpandConstant('{app}'));
end;
