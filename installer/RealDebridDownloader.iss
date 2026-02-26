#define MyAppName "Real-Debrid Downloader"
#define MyAppExeName "Real-Debrid-Downloader.exe"

#ifndef MyAppVersion
  #define MyAppVersion "1.0.0"
#endif

#ifndef MySourceExe
  #define MySourceExe "dist\\Real-Debrid-Downloader.exe"
#endif

#ifndef MyOutputDir
  #define MyOutputDir "release"
#endif

[Setup]
AppId={{C0E95B39-389E-4D2C-8E1E-12A44E8AE8E0}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher=Sucukdeluxe
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
OutputDir={#MyOutputDir}
OutputBaseFilename=Real-Debrid-Downloader-Setup-{#MyAppVersion}
Compression=lzma
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayIcon={app}\{#MyAppExeName}

[Languages]
Name: "german"; MessagesFile: "compiler:Languages\German.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Desktop-Verknuepfung erstellen"; GroupDescription: "Zusaetzliche Aufgaben:"; Flags: unchecked

[Files]
Source: "{#MySourceExe}"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "{#MyAppName} starten"; Flags: nowait postinstall skipifsilent
