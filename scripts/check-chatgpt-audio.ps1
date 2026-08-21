<#
.SYNOPSIS
  ChatGPT デスクトップアプリが音声を認識しないときの診断／自動復旧。

.DESCRIPTION
  確定構成:「ChatGPT の耳」= Windows の録音「既定の通信デバイス」= Voicemeeter Out B1。
  この経路のどこが切れているかを実測する。目視や推測ではなく VoiceMeeter Remote API から
  実際のレベル(dB)を読むので、「ChatGPT に声が届いているか」を数値で確定できる。

.EXAMPLE
  pwsh -File scripts/check-chatgpt-audio.ps1
  pwsh -File scripts/check-chatgpt-audio.ps1 -Fix
  pwsh -File scripts/check-chatgpt-audio.ps1 -Fix -Mic 'マイク配列'
#>
[CmdletBinding()]
param(
  [switch]$Fix,
  [string]$Mic = 'マイク配列',
  [int]$LevelSeconds = 4
)

$ErrorActionPreference = 'Stop'
$script:Fail = 0
$script:Warn = 0

function Ok    ($m) { Write-Host "  [OK]   $m" -ForegroundColor Green }
function Bad   ($m) { Write-Host "  [NG]   $m" -ForegroundColor Red;    $script:Fail++ }
function Caution ($m) { Write-Host "  [注意] $m" -ForegroundColor Yellow; $script:Warn++ }
function Info  ($m) { Write-Host "         $m" -ForegroundColor DarkGray }
function Head  ($m) { Write-Host ""; Write-Host $m -ForegroundColor Cyan }

# ────────────────────────────────────────────────────────────────
# 1. Windows の既定デバイス（ChatGPT の耳 = 録音の「既定の通信デバイス」）
# ────────────────────────────────────────────────────────────────
$coreAudio = @'
using System;
using System.Runtime.InteropServices;
public static class AudioDef {
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] internal class MMDeviceEnumerator {}
  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  internal interface IMMDeviceEnumerator {
    int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppEndpoint);
  }
  [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  internal interface IMMDevice {
    int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams, out IntPtr ppInterface);
    int OpenPropertyStore(int stgmAccess, out IPropertyStore ppProperties);
    int GetId([MarshalAs(UnmanagedType.LPWStr)] out string ppstrId);
    int GetState(out int pdwState);
  }
  [Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  internal interface IPropertyStore {
    int GetCount(out int c); int GetAt(int i, out PROPERTYKEY k);
    int GetValue(ref PROPERTYKEY key, out PROPVARIANT pv);
    int SetValue(ref PROPERTYKEY key, ref PROPVARIANT pv); int Commit();
  }
  [StructLayout(LayoutKind.Sequential)] internal struct PROPERTYKEY { public Guid fmtid; public int pid; }
  [StructLayout(LayoutKind.Explicit)] internal struct PROPVARIANT { [FieldOffset(0)] public short vt; [FieldOffset(8)] public IntPtr p; }
  public static string GetDefault(int dataFlow, int role) {
    var en = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
    IMMDevice dev = null;
    if (en.GetDefaultAudioEndpoint(dataFlow, role, out dev) != 0 || dev == null) return "(none)";
    IPropertyStore st; dev.OpenPropertyStore(0, out st);
    var key = new PROPERTYKEY { fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"), pid = 14 };
    PROPVARIANT pv; st.GetValue(ref key, out pv);
    return Marshal.PtrToStringUni(pv.p);
  }
}
'@
if (-not ('AudioDef' -as [type])) { Add-Type -TypeDefinition $coreAudio -Language CSharp }

$playDefault = [AudioDef]::GetDefault(0, 0)
$playComm    = [AudioDef]::GetDefault(0, 2)
$recDefault  = [AudioDef]::GetDefault(1, 0)
$recComm     = [AudioDef]::GetDefault(1, 2)

Head "1. Windows の既定デバイス"
Info "再生 既定       : $playDefault"
Info "再生 既定の通信 : $playComm"
Info "録音 既定       : $recDefault"
Info "録音 既定の通信 : $recComm"

if ($recComm -match 'Voicemeeter Out B1') {
  Ok "ChatGPT の耳 = Voicemeeter Out B1"
} else {
  Bad "ChatGPT の耳が Voicemeeter Out B1 ではない（現在: $recComm）"
  Info "直し方: mmsys.cpl → 録音タブ → Voicemeeter Out B1 → 既定値に設定 ▼ → 既定の通信デバイス"
}
if ($recDefault -match 'Voicemeeter|CABLE') {
  Caution "録音の『既定』が仮想デバイス（$recDefault）。ブラウザ用には物理マイクを既定にする"
}
if ($playDefault -match 'CABLE|Voicemeeter') {
  Bad "再生の『既定』が仮想デバイス（$playDefault）。他アプリの音が AI の声として収録に混ざる"
} else {
  Ok "再生の既定は物理デバイス（$playDefault）"
}
if ($playComm -match 'CABLE|Voicemeeter') {
  Bad "再生の『既定の通信』が仮想デバイス（$playComm）"
}

# ────────────────────────────────────────────────────────────────
# 2. 必要なエンドポイントが有効か
# ────────────────────────────────────────────────────────────────
Head "2. 必要な仮想デバイスが有効か"
function Get-EndpointState([string]$flow, [string]$namePattern) {
  $root = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\$flow"
  Get-ChildItem $root | ForEach-Object {
    $n = $null
    try { $n = (Get-ItemProperty (Join-Path $_.PSPath 'Properties')).'{a45c254e-df1c-4efd-8020-67d146a850e0},2' } catch {}
    if ($n -and $n -like $namePattern) {
      [pscustomobject]@{ Name = $n; State = (Get-ItemProperty $_.PSPath).DeviceState }
    }
  }
}
$required = @(
  @{ Flow = 'Capture'; Pattern = 'Voicemeeter Out B1*'; Why = 'ChatGPT の耳' },
  @{ Flow = 'Capture'; Pattern = 'CABLE Output*';       Why = 'ChatGPT の声をアプリが録る場所' },
  @{ Flow = 'Render';  Pattern = 'CABLE Input*';        Why = 'ChatGPT の声の出口' },
  @{ Flow = 'Render';  Pattern = 'Voicemeeter Input*';  Why = 'アプリから ChatGPT へ送る入口' }
)
foreach ($r in $required) {
  $d = @(Get-EndpointState $r.Flow $r.Pattern)
  if ($d.Count -eq 0) {
    Bad "$($r.Pattern) が存在しない（$($r.Why)）"
  } elseif ($d | Where-Object { $_.State -eq 1 }) {
    Ok "$($d[0].Name) : 有効（$($r.Why)）"
  } else {
    Bad "$($d[0].Name) が無効／未接続（$($r.Why)）— mmsys.cpl で有効化する"
  }
}

# ────────────────────────────────────────────────────────────────
# 3. VoiceMeeter の実測
# ────────────────────────────────────────────────────────────────
Head "3. VoiceMeeter の実測"
$vmProc = Get-Process voicemeeter, voicemeeter_x64, voicemeeter8, voicemeeter8x64 -ErrorAction SilentlyContinue
if (-not $vmProc) {
  Bad "VoiceMeeter が起動していない → B1 は無音、ChatGPT には何も聞こえない"
  Info "直し方: VoiceMeeter を起動し、Menu で System Tray / Run on Windows Startup を有効にする"
} else {
  Ok "VoiceMeeter 起動中（PID $($vmProc[0].Id)）"
}

$dll = 'C:\Program Files (x86)\VB\Voicemeeter\VoicemeeterRemote64.dll'
if (-not (Test-Path $dll)) { $dll = 'C:\Program Files (x86)\VB\Voicemeeter\VoicemeeterRemote.dll' }

$remoteSrc = @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class VMR {
  const string DLL = @"$dll";
  [DllImport(DLL, CallingConvention = CallingConvention.StdCall)] public static extern int VBVMR_Login();
  [DllImport(DLL, CallingConvention = CallingConvention.StdCall)] public static extern int VBVMR_Logout();
  [DllImport(DLL, CallingConvention = CallingConvention.StdCall)] public static extern int VBVMR_IsParametersDirty();
  [DllImport(DLL, CallingConvention = CallingConvention.StdCall)] public static extern int VBVMR_GetParameterFloat([MarshalAs(UnmanagedType.LPStr)] string p, ref float v);
  [DllImport(DLL, CallingConvention = CallingConvention.StdCall)] public static extern int VBVMR_SetParameterFloat([MarshalAs(UnmanagedType.LPStr)] string p, float v);
  [DllImport(DLL, CallingConvention = CallingConvention.StdCall)] public static extern int VBVMR_GetParameterStringW([MarshalAs(UnmanagedType.LPStr)] string p, [MarshalAs(UnmanagedType.LPWStr)] StringBuilder s);
  [DllImport(DLL, CallingConvention = CallingConvention.StdCall)] public static extern int VBVMR_SetParameterStringW([MarshalAs(UnmanagedType.LPStr)] string p, [MarshalAs(UnmanagedType.LPWStr)] string s);
  [DllImport(DLL, CallingConvention = CallingConvention.StdCall)] public static extern int VBVMR_GetLevel(int type, int channel, ref float v);
  public static string GetStr(string p) { var sb = new StringBuilder(1024); VBVMR_GetParameterStringW(p, sb); return sb.ToString(); }
  public static float GetF(string p) { float v = 0; VBVMR_GetParameterFloat(p, ref v); return v; }
  public static float Level(int t, int c) { float v = 0; VBVMR_GetLevel(t, c, ref v); return v; }
}
"@
if (-not ('VMR' -as [type])) { Add-Type -TypeDefinition $remoteSrc -Language CSharp }

function ConvertTo-Db([double]$v) {
  if ($v -le 0.0000001) { return '-inf' }
  return ('{0:N1} dB' -f (20 * [Math]::Log10($v)))
}

$login = [VMR]::VBVMR_Login()
if ($login -lt 0) {
  Bad "VoiceMeeter Remote API に接続できない（code $login）"
} else {
  Start-Sleep -Milliseconds 300
  [void][VMR]::VBVMR_IsParametersDirty()

  $in1     = [VMR]::GetStr('Strip[0].device.name')
  $in1A1   = [VMR]::GetF('Strip[0].A1')
  $in1B1   = [VMR]::GetF('Strip[0].B1')
  $in1Mute = [VMR]::GetF('Strip[0].mute')
  $vioA1   = [VMR]::GetF('Strip[2].A1')
  $vioB1   = [VMR]::GetF('Strip[2].B1')
  $a1dev   = [VMR]::GetStr('Bus[0].device.name')

  Info "IN1 デバイス     : $(if ($in1) { $in1 } else { '(未割当)' })"
  Info "IN1 ルーティング : A1=$([int]$in1A1)  B1=$([int]$in1B1)  mute=$([int]$in1Mute)"
  Info "Virtual Input    : A1=$([int]$vioA1)  B1=$([int]$vioB1)"
  Info "A1 出力デバイス  : $(if ($a1dev) { $a1dev } else { '(未割当)' })"

  if (-not $in1) {
    Bad "IN1 が未割当 → あなたの声が B1 に流れない"
  } elseif ($in1 -match 'CABLE') {
    Bad "IN1 に $in1 が割り当たっている → ChatGPT の声が ChatGPT の耳へ戻る自己ループ"
  } elseif ($in1 -notmatch [regex]::Escape($Mic)) {
    Bad "IN1 が『$Mic』ではなく『$in1』"
    Info "イヤホン等を接続すると、ここが別デバイスへ変わる／開けなくなることがある"
  } else {
    Ok "IN1 = $in1"
  }

  if ($in1B1 -lt 0.5) { Bad "IN1 の B が消灯 → あなたの声が ChatGPT に届かない" } else { Ok "IN1 の B 点灯" }
  if ($in1A1 -ge 0.5) { Caution "IN1 の A が点灯 → 自分の声がスピーカーへ出る（ハウリング要因）" }
  if ($in1Mute -ge 0.5) { Bad "IN1 が MUTE されている" }
  if ($vioB1 -lt 0.5) { Bad "Virtual Input の B が消灯 → アプリ経由の音（相手の声）が ChatGPT に届かない" } else { Ok "Virtual Input の B 点灯" }
  if ($vioA1 -ge 0.5) { Caution "Virtual Input の A が点灯 → 自分の声が遅れて返ってくる" }

  if ($Fix) {
    Head "4. 自動復旧を実行"
    [void][VMR]::VBVMR_SetParameterStringW('Strip[0].device.wdm', $Mic)
    [void][VMR]::VBVMR_SetParameterFloat('Strip[0].A1', 0)
    [void][VMR]::VBVMR_SetParameterFloat('Strip[0].B1', 1)
    [void][VMR]::VBVMR_SetParameterFloat('Strip[0].mute', 0)
    [void][VMR]::VBVMR_SetParameterFloat('Strip[2].A1', 0)
    [void][VMR]::VBVMR_SetParameterFloat('Strip[2].B1', 1)
    Start-Sleep -Milliseconds 400
    [void][VMR]::VBVMR_SetParameterFloat('Command.Restart', 1)
    Start-Sleep -Seconds 3
    Info "復旧後の IN1: $(if ([VMR]::GetStr('Strip[0].device.name')) { [VMR]::GetStr('Strip[0].device.name') } else { '(未割当)' })"
  }

  Head "5. レベル実測（$LevelSeconds 秒）— この間に声を出してください"
  $peakIn = 0.0
  $peakB1 = 0.0
  $deadline = (Get-Date).AddSeconds($LevelSeconds)
  while ((Get-Date) -lt $deadline) {
    foreach ($ch in 0, 1) { $v = [VMR]::Level(0, $ch); if ($v -gt $peakIn) { $peakIn = $v } }
    foreach ($ch in 8, 9) { $v = [VMR]::Level(3, $ch); if ($v -gt $peakB1) { $peakB1 = $v } }
    Start-Sleep -Milliseconds 30
  }
  Info "IN1 入力ピーク    : $(ConvertTo-Db $peakIn)"
  Info "B1 バス出力ピーク : $(ConvertTo-Db $peakB1)   ← ChatGPT が実際に聞いている音"

  if ($peakB1 -lt 0.0005) {
    Bad "B1 が無音。ChatGPT には何も届いていない"
  } elseif ($peakB1 -lt 0.01) {
    Caution "B1 のレベルが非常に小さい（-40dB 未満）。ChatGPT が声を検出できない可能性がある"
  } else {
    Ok "B1 に声が乗っている → 配線は正常。ChatGPT アプリ側（ミュート・アプリ内設定）を疑う"
  }

  [void][VMR]::VBVMR_Logout()
}

# ────────────────────────────────────────────────────────────────
# 6. ChatGPT アプリ側
# ────────────────────────────────────────────────────────────────
Head "6. ChatGPT アプリ"
$gpt     = @(Get-Process ChatGPT -ErrorAction SilentlyContinue)
$classic = @(Get-Process 'ChatGPT Classic' -ErrorAction SilentlyContinue)
if ($gpt.Count -gt 0 -and $classic.Count -gt 0) {
  Caution "ChatGPT と ChatGPT Classic が同時起動。設定が効くのは片方だけ — 使わない方は完全終了する"
} elseif ($gpt.Count -gt 0) {
  Ok "ChatGPT 起動中"
} elseif ($classic.Count -gt 0) {
  Ok "ChatGPT Classic 起動中"
} else {
  Info "ChatGPT は起動していない"
}
Info "確認: 音声モードのマイクボタンにカーソルを合わせると Communications - <デバイス名> が出る"
Info "既定の通信デバイスを変えたら ChatGPT はタスクトレイからも完全終了して再起動する"

Write-Host ""
if ($script:Fail -eq 0 -and $script:Warn -eq 0) {
  Write-Host "結果: 問題なし" -ForegroundColor Green
} else {
  $color = if ($script:Fail -gt 0) { 'Red' } else { 'Yellow' }
  Write-Host "結果: NG $($script:Fail) 件 / 注意 $($script:Warn) 件" -ForegroundColor $color
  if ($script:Fail -gt 0 -and -not $Fix) {
    Write-Host "VoiceMeeter 側の問題なら次で自動復旧できます:" -ForegroundColor Yellow
    Write-Host "  pwsh -File scripts/check-chatgpt-audio.ps1 -Fix" -ForegroundColor Yellow
  }
}
