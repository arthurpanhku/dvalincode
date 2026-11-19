; DvalinCode — Windows installer (Inno Setup 6)
;
; Produces a per-user setup executable for the desktop GUI app: the same
; webview-bun binary scripts/build-gui.sh compiles, installed under
; %LocalAppData%\Programs\DvalinCode with a Start menu entry, an optional
; desktop shortcut and an uninstall entry. Before this, Windows users had to
; unzip an archive and find an .exe inside it, or run the CLI's `serve` and
; work in a browser tab.
;
; Per-user on purpose (PrivilegesRequired=lowest): installing into the user's
; own profile needs no administrator, so the install raises no UAC prompt and
; a machine-wide change is never made on the user's behalf.
;
; Built by scripts/build-gui.sh on a Windows host, which passes every path in:
;   ISCC /DAppVersion=0.0.0 /DSourceDir=... /DIconFile=... /DLicenseFile=...
;        /DOutputDir=... /DOutputBaseFilename=... installer\windows\dvalincode.iss
;
; SourceDir is the packaged payload directory: the compiled GUI executable
; beside the web\dist assets it serves. The executable is installed under the
; name DvalinCode.exe — the build-time name carries a platform suffix that has
; no meaning once it is on one machine, and this is the name the shortcut, the
; taskbar and Task Manager show.

#ifndef AppVersion
  #error "AppVersion must be passed with /DAppVersion=<version>"
#endif
#ifndef SourceDir
  #error "SourceDir must be passed with /DSourceDir=<packaged payload directory>"
#endif
#ifndef SourceExe
  #define SourceExe "dvalincode-gui-windows-x64.exe"
#endif
#ifndef OutputDir
  #define OutputDir "..\..\release-gui"
#endif
#ifndef OutputBaseFilename
  #define OutputBaseFilename "dvalincode-gui-v" + AppVersion + "-windows-x64-setup"
#endif
#ifndef IconFile
  #define IconFile "dvalincode.ico"
#endif

#define AppName "DvalinCode"
#define AppPublisher "DvalinCode"
#define AppUrl "https://dvalincode.dev"
#define InstalledExe "DvalinCode.exe"

[Setup]
; Never change AppId: it is what Windows matches an upgrade against, and what
; the uninstaller is registered under.
AppId={{B6A1F6C7-6A94-4E2C-9F4B-2D7A1C0E58D3}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
VersionInfoVersion={#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL={#AppUrl}
AppSupportURL=https://github.com/arthurpanhku/dvalincode/issues
AppUpdatesURL=https://github.com/arthurpanhku/dvalincode/releases
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
DisableDirPage=auto
; Per-user install — no administrator, no UAC prompt, nothing written outside
; the user's profile. {autopf} resolves to %LocalAppData%\Programs here.
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ArchitecturesAllowed=x64 arm64
OutputDir={#OutputDir}
OutputBaseFilename={#OutputBaseFilename}
SetupIconFile={#IconFile}
UninstallDisplayIcon={app}\{#InstalledExe}
UninstallDisplayName={#AppName}
WizardStyle=modern
Compression=lzma2/max
SolidCompression=yes
; The window process holds the server child; both must be gone before their
; files are replaced. Inno asks, closes them, and restarts nothing by itself.
CloseApplications=yes
RestartApplications=no
#ifdef LicenseFile
LicenseFile={#LicenseFile}
#endif

[Languages]
; Only the translations Inno Setup itself ships can be named here — a
; MessagesFile the compiler cannot find fails the build, and Chinese is a
; third-party .isl that is not in the distribution.
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "{#SourceDir}\{#SourceExe}"; DestDir: "{app}"; DestName: "{#InstalledExe}"; Flags: ignoreversion
; web\dist must stay beside the executable: a compiled Bun binary resolves its
; static assets next to itself, not from the virtual bundle path.
Source: "{#SourceDir}\web\dist\*"; DestDir: "{app}\web\dist"; Flags: ignoreversion recursesubdirs createallsubdirs
#ifdef LicenseFile
Source: "{#LicenseFile}"; DestDir: "{app}"; DestName: "LICENSE.txt"; Flags: ignoreversion
#endif
#ifdef NoticesFile
Source: "{#NoticesFile}"; DestDir: "{app}"; Flags: ignoreversion
#endif

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#InstalledExe}"
Name: "{group}\{cm:UninstallProgram,{#AppName}}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#InstalledExe}"; Tasks: desktopicon

[Run]
; The WebView2 bootstrapper is downloaded only when the runtime is missing
; (see PrepareToInstall) and installs per-user, like everything else here.
Filename: "{tmp}\MicrosoftEdgeWebview2Setup.exe"; Parameters: "/silent /install"; \
  StatusMsg: "Installing Microsoft Edge WebView2 Runtime..."; \
  Flags: waituntilterminated; Check: NeedsWebView2
Filename: "{app}\{#InstalledExe}"; Description: "{cm:LaunchProgram,{#AppName}}"; \
  Flags: nowait postinstall skipifsilent

[UninstallDelete]
; web\dist is installed with createallsubdirs, and an upgrade that drops a file
; would otherwise leave it behind for the uninstaller to miss. Remove the tree.
Type: filesandordirs; Name: "{app}\web"

[Code]
const
  { Evergreen WebView2 Runtime, the client GUID Microsoft registers it under. }
  WebView2ClientKey = 'Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}';
  WebView2BootstrapperUrl = 'https://go.microsoft.com/fwlink/p/?LinkId=2124703';

var
  WebView2Missing: Boolean;
  DownloadPage: TDownloadWizardPage;

function ReadWebView2Version(RootKey: Integer; const SubKey: String): String;
var
  Value: String;
begin
  if RegQueryStringValue(RootKey, SubKey, 'pv', Value) then
    Result := Value
  else
    Result := '';
end;

{ The runtime ships with Windows 11 and reaches most Windows 10 machines
  through Edge, but it is not guaranteed: without it the window would open
  blank, which is the one failure a user cannot diagnose. }
function WebView2Installed: Boolean;
var
  Version: String;
begin
  Version := ReadWebView2Version(HKEY_LOCAL_MACHINE, 'SOFTWARE\WOW6432Node\' + WebView2ClientKey);
  if Version = '' then
    Version := ReadWebView2Version(HKEY_LOCAL_MACHINE, 'SOFTWARE\' + WebView2ClientKey);
  if Version = '' then
    Version := ReadWebView2Version(HKEY_CURRENT_USER, 'Software\' + WebView2ClientKey);
  Result := (Version <> '') and (Version <> '0.0.0.0');
end;

function NeedsWebView2: Boolean;
begin
  Result := WebView2Missing;
end;

procedure InitializeWizard;
begin
  WebView2Missing := not WebView2Installed;
  DownloadPage := CreateDownloadPage(SetupMessage(msgWizardPreparing), SetupMessage(msgPreparingDesc), nil);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
  if not WebView2Missing then
    Exit;

  DownloadPage.Clear;
  DownloadPage.Add(WebView2BootstrapperUrl, 'MicrosoftEdgeWebview2Setup.exe', '');
  DownloadPage.Show;
  try
    try
      DownloadPage.Download;
    except
      { Offline, or the download was cancelled. Installing anyway is better
        than failing: the app works the moment the runtime arrives through
        Windows Update or Edge, and the message says what is missing. }
      WebView2Missing := False;
      SuppressibleMsgBox(
        'The Microsoft Edge WebView2 Runtime could not be downloaded, so DvalinCode will be installed without it.'#13#10#13#10 +
        'If the app window opens blank, install the runtime from https://go.microsoft.com/fwlink/p/?LinkId=2124703 and start DvalinCode again.',
        mbInformation, MB_OK, IDOK);
    end;
  finally
    DownloadPage.Hide;
  end;
end;
