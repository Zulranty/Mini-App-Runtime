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
; Update built-in mini-app code on every framework install, but never replace
; user data, runtime state, or unrelated user apps.
Source: "{#SourceDir}\MiniApps\*"; DestDir: "{app}\MiniApps"; Excludes: "MiniApps\.runtime\*;MiniApps\*\storage.json;MiniApps\*\storage.json.bak"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#SourceDir}\Interface\*"; DestDir: "{app}\Interface"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autostartmenu}\{#ProductName}"; Filename: "{app}\MiniApps.exe"

[Run]
Filename: "{app}\MiniApps.exe"; Description: "Запустить {#ProductName}"; Flags: nowait postinstall skipifsilent

[Code]
function RuntimeAt(const DotnetRoot: String): Boolean;
var
  FindRec: TFindRec;
  Version, Major: String;
begin
  Result := False;
  if (DotnetRoot = '') or not FindFirst(AddBackslash(DotnetRoot) + 'shared\Microsoft.WindowsDesktop.App\*', FindRec) then exit;
  repeat
    Version := FindRec.Name;
    Major := Copy(Version, 1, Pos('.', Version) - 1);
    if StrToIntDef(Major, 0) >= 8 then begin
      Result := True;
      break;
    end;
  until not FindNext(FindRec);
  FindClose(FindRec);
end;

function RuntimeLineCompatible(const Line: String): Boolean;
var
  Version, Major: String;
begin
  Result := False;
  if Pos('Microsoft.WindowsDesktop.App ', Line) <> 1 then exit;
  Version := Copy(Line, Length('Microsoft.WindowsDesktop.App ') + 1, MaxInt);
  Major := Copy(Version, 1, Pos('.', Version) - 1);
  Result := StrToIntDef(Major, 0) >= 8;
end;

function RuntimeListedByDotnet(): Boolean;
var
  OutputFile: String;
  ExitCode, Index: Integer;
  Lines: TArrayOfString;
begin
  Result := False;
  OutputFile := ExpandConstant('{tmp}\miniapp-dotnet-runtimes.txt');
  if Exec(ExpandConstant('{cmd}'), '/C dotnet --list-runtimes > "' + OutputFile + '" 2>NUL', '', SW_HIDE, ewWaitUntilTerminated, ExitCode) and
     (ExitCode = 0) and LoadStringsFromFile(OutputFile, Lines) then begin
    for Index := 0 to GetArrayLength(Lines) - 1 do
      if RuntimeLineCompatible(Lines[Index]) then begin Result := True; break; end;
  end;
  DeleteFile(OutputFile);
end;

function RuntimeInRegistry(): Boolean;
var
  Version: String;
begin
  Result := RegQueryStringValue(HKLM64, 'SOFTWARE\dotnet\Setup\InstalledVersions\x64\sharedfx\Microsoft.WindowsDesktop.App', 'Version', Version) and
    (StrToIntDef(Copy(Version, 1, Pos('.', Version) - 1), 0) >= 8);
  if not Result then
    Result := RegQueryStringValue(HKCU64, 'SOFTWARE\dotnet\Setup\InstalledVersions\x64\sharedfx\Microsoft.WindowsDesktop.App', 'Version', Version) and
      (StrToIntDef(Copy(Version, 1, Pos('.', Version) - 1), 0) >= 8);
end;

function RuntimeVersionInstalled(): Boolean;
begin
  Result := RuntimeAt(ExpandConstant('{autopf}\dotnet')) or
    RuntimeAt(ExpandConstant('{localappdata}\Microsoft\dotnet')) or
    RuntimeAt(GetEnv('DOTNET_ROOT')) or
    RuntimeListedByDotnet() or
    RuntimeInRegistry();
end;

function InitializeSetup(): Boolean;
var
  ResultCode: Integer;
begin
  Result := RuntimeVersionInstalled();
  if Result then exit;
  if MsgBox('Для работы требуется .NET 8 Desktop Runtime (x64) или новее. Открыть страницу загрузки?', mbError, MB_YESNO) = IDYES then
    ShellExec('open', 'https://dotnet.microsoft.com/download/dotnet/8.0/runtime', '', '', SW_SHOWNORMAL, ewNoWait, ResultCode);
  MsgBox('Установите .NET Desktop Runtime x64 и снова запустите установщик.', mbInformation, MB_OK);
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
