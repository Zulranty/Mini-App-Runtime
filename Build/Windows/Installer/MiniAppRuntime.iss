#define ProductName "Mini App Runtime"
#define ProductVersion GetEnv('MINIAPP_PRODUCT_VERSION')
#define SourceDir GetEnv('MINIAPP_SETUP_SOURCE')
#define OutputDir GetEnv('MINIAPP_SETUP_OUTPUT')

[Setup]
AppId={{B930A6CB-7018-4CDE-A5FA-C948B64E91D7}
AppName={#ProductName}
AppVersion={#ProductVersion}
DefaultDirName={localappdata}\MiniApps
DisableDirPage=no
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={#OutputDir}
OutputBaseFilename=MiniAppsSetup
Compression=lzma2/ultra64
SolidCompression=yes
CloseApplications=yes
RestartApplications=no
UninstallDisplayName={#ProductName}
UninstallFilesDir={app}\Data

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Excludes: "MiniApps\*,Interface\*"; Flags: ignoreversion recursesubdirs createallsubdirs
; The host installs Data\BundledMiniApps through its package transaction.
Source: "{#SourceDir}\MiniApps\Modules\*"; DestDir: "{app}\MiniApps\Modules"; Flags: ignoreversion recursesubdirs createallsubdirs skipifsourcedoesntexist
Source: "{#SourceDir}\Interface\*"; DestDir: "{app}\Interface"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autostartmenu}\{#ProductName}"; Filename: "{app}\MiniApps.exe"

[Run]
Filename: "{app}\MiniApps.exe"; Description: "Запустить {#ProductName}"; Flags: nowait postinstall skipifsilent

[Code]
function GetBinaryType(const ApplicationName: String; var BinaryType: Cardinal): Boolean;
  external 'GetBinaryTypeW@kernel32.dll stdcall';

function RuntimeAt(const DotnetRoot: String): Boolean;
var
  FindRec: TFindRec;
  DesktopRoot, Version: String;
  BinaryType: Cardinal;
begin
  Result := False;
  if DotnetRoot = '' then exit;
  { The x64 registration points to the host used by the application.
    Do not infer an x64 host from a dotnet on PATH or a runtime folder name. }
  if not GetBinaryType(AddBackslash(DotnetRoot) + 'dotnet.exe', BinaryType) then exit;
  if BinaryType <> 6 then exit; { SCS_64BIT_BINARY }
  DesktopRoot := AddBackslash(DotnetRoot) + 'shared\Microsoft.WindowsDesktop.App\';
  if not FindFirst(DesktopRoot + '10.0.*', FindRec) then exit;
  repeat
    Version := FindRec.Name;
    if (Pos('-', Version) = 0) and
       FileExists(DesktopRoot + Version + '\System.Windows.Forms.dll') and
       FileExists(AddBackslash(DotnetRoot) + 'shared\Microsoft.NETCore.App\' + Version + '\coreclr.dll') then
    begin
      Result := True;
      break;
    end;
  until not FindNext(FindRec);
  FindClose(FindRec);
end;

function RuntimeVersionInstalled(): Boolean;
var
  RuntimeRoot: String;
begin
  RuntimeRoot := GetEnv('DOTNET_ROOT_X64');
  if RuntimeRoot = '' then RuntimeRoot := GetEnv('DOTNET_ROOT');
  if RuntimeRoot <> '' then begin
    Result := RuntimeAt(RuntimeRoot);
    exit;
  end;
  if RegQueryStringValue(HKLM64, 'SOFTWARE\dotnet\Setup\InstalledVersions\x64',
      'InstallLocation', RuntimeRoot) then
    Result := RuntimeAt(RuntimeRoot)
  else
    Result := RuntimeAt(ExpandConstant('{commonpf64}\dotnet'));
end;

function WebView2At(RootKey: Integer): Boolean;
var
  Version: String;
begin
  Result := RegQueryStringValue(RootKey,
    'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
    'pv', Version) and (Version <> '') and (Version <> '0.0.0.0');
end;

function InitializeSetup(): Boolean;
var
  ResultCode: Integer;
begin
  Result := False;
  if not RuntimeVersionInstalled() then begin
    if WizardSilent then exit;
    if MsgBox('Требуется .NET 10 Desktop Runtime (x64). Открыть страницу загрузки?', mbError, MB_YESNO) = IDYES then
      ShellExec('open', 'https://dotnet.microsoft.com/download/dotnet/10.0', '', '', SW_SHOWNORMAL, ewNoWait, ResultCode);
    exit;
  end;
  if not (WebView2At(HKLM32) or WebView2At(HKCU)) then begin
    if WizardSilent then exit;
    if MsgBox('Требуется Microsoft Edge WebView2 Runtime. Открыть страницу загрузки?', mbError, MB_YESNO) = IDYES then
      ShellExec('open', 'https://developer.microsoft.com/microsoft-edge/webview2/', '', '', SW_SHOWNORMAL, ewNoWait, ResultCode);
    exit;
  end;
  Result := True;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  TestFile, SelectedDirectory: String;
begin
  Result := True;
  if CurPageID <> wpSelectDir then exit;
  SelectedDirectory := WizardForm.DirEdit.Text;
  while (Length(SelectedDirectory) > 3) and (SelectedDirectory[Length(SelectedDirectory)] = '\') do
    Delete(SelectedDirectory, Length(SelectedDirectory), 1);
  if Pos('\miniapps\', Lowercase(AddBackslash(SelectedDirectory))) = 0 then
    WizardForm.DirEdit.Text := AddBackslash(SelectedDirectory) + 'MiniApps';
  if not ForceDirectories(WizardDirValue) then begin
    MsgBox('Не удалось создать выбранную папку установки.', mbError, MB_OK);
    Result := False;
    exit;
  end;
  TestFile := AddBackslash(WizardDirValue) + '.miniapp-write-test';
  if not SaveStringToFile(TestFile, 'test', False) then begin
    MsgBox('Выберите папку, в которую у текущего пользователя есть право записи.', mbError, MB_OK);
    Result := False;
    exit;
  end;
  DeleteFile(TestFile);
end;
