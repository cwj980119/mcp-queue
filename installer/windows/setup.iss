#ifndef AppVersion
  #define AppVersion "0.2.0"
#endif
[Setup]
AppId={{A3CF6BFA-46CB-42A0-A940-E87D944D3506}
AppName=MCP Queue
AppVersion={#AppVersion}
AppPublisher=cwj980119
AppPublisherURL=https://github.com/cwj980119/mcp-queue
AppSupportURL=https://github.com/cwj980119/mcp-queue/issues
DefaultDirName={localappdata}\Programs\MCPQueue
DefaultGroupName=MCP Queue
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
AppMutex=Local\McpQueueDesktop
CloseApplications=no
DisableWelcomePage=yes
DisableDirPage=yes
DisableProgramGroupPage=yes
WizardStyle=modern
OutputDir={#OutputDirectory}
OutputBaseFilename=MCP-Queue-Setup
Compression=lzma2
SolidCompression=yes
UninstallDisplayIcon={app}\MCPQueue.exe
SetupLogging=yes
[Languages]
Name: "korean"; MessagesFile: "compiler:Languages\Korean.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"
[Files]
Source: "{#PayloadDirectory}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
[Icons]
Name: "{group}\MCP Queue"; Filename: "{app}\MCPQueue.exe"; WorkingDir: "{app}"
Name: "{autodesktop}\MCP Queue"; Filename: "{app}\MCPQueue.exe"; WorkingDir: "{app}"
[Run]
Filename: "{app}\MCPQueue.exe"; Description: "MCP Queue 시작"; Flags: nowait postinstall skipifsilent
