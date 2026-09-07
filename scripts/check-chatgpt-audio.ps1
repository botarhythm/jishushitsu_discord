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
  [int]$LevelSeconds = 4,
  # 音声対話に使っている方のアプリのプロセス名。
  # この PC では 'ChatGPT' は Codex で、音声対話は 'ChatGPT Classic'。
  [string]$VoiceApp = 'ChatGPT Classic'
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
    int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppEndpoint);
  }
  [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  internal interface IMMDeviceCollection {
    int GetCount(out uint count);
    int Item(uint index, out IMMDevice device);
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
  [ComImport, Guid("870AF99C-171D-4F9E-AF0D-E63DF40C2BC9")] internal class PolicyConfigClient {}
  [Guid("568B9108-44BF-40B4-9006-86AFE5B5A620"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  internal interface IPolicyConfig {
    int GetMixFormat(); int GetDeviceFormat(); int ResetDeviceFormat(); int SetDeviceFormat();
    int GetProcessingPeriod(); int SetProcessingPeriod(); int GetShareMode(); int SetShareMode();
    int GetPropertyValue(); int SetPropertyValue(); int SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string id, int role);
    int SetEndpointVisibility();
  }
  static string FriendlyName(IMMDevice dev) {
    IPropertyStore st; dev.OpenPropertyStore(0, out st);
    var key = new PROPERTYKEY { fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"), pid = 14 };
    PROPVARIANT pv; st.GetValue(ref key, out pv);
    return Marshal.PtrToStringUni(pv.p) ?? "";
  }
  public static string GetDefault(int dataFlow, int role) {
    var en = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
    IMMDevice dev = null;
    if (en.GetDefaultAudioEndpoint(dataFlow, role, out dev) != 0 || dev == null) return "(none)";
    return FriendlyName(dev);
  }
  public static string[] GetActiveEndpoints(int dataFlow) {
    var en = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
    IMMDeviceCollection devices; en.EnumAudioEndpoints(dataFlow, 1, out devices);
    uint count; devices.GetCount(out count);
    var result = new string[count];
    for (uint i = 0; i < count; i++) {
      IMMDevice dev; devices.Item(i, out dev); string id; dev.GetId(out id);
      result[i] = id + "\t" + FriendlyName(dev);
    }
    return result;
  }
  public static int SetDefault(string endpointId, int role) {
    return ((IPolicyConfig)(new PolicyConfigClient())).SetDefaultEndpoint(endpointId, role);
  }
}
'@
if (-not ('AudioDef' -as [type])) { Add-Type -TypeDefinition $coreAudio -Language CSharp }

$playDefault = [AudioDef]::GetDefault(0, 0)
$playComm    = [AudioDef]::GetDefault(0, 2)
$recDefault  = [AudioDef]::GetDefault(1, 0)
$recComm     = [AudioDef]::GetDefault(1, 2)
$activeCapture = @(
  [AudioDef]::GetActiveEndpoints(1) | ForEach-Object {
    $parts = $_ -split "`t", 2
    if ($parts.Count -eq 2) {
      # IMMDevice::GetId が返す opaque な完全 ID をそのまま PolicyConfig に渡す。
      [pscustomobject]@{ Id = $parts[0]; Name = $parts[1] }
    }
  }
)
$b1Candidates = @($activeCapture | Where-Object { $_.Name -like 'Voicemeeter Out B1*' })
$micCandidates = @($activeCapture | Where-Object { $_.Name -like "*$Mic*" -and $_.Name -notmatch 'CABLE|Voicemeeter' })

Head "0. 修復計画プリフライト"
$preflightBlocked = $false
if ($b1Candidates.Count -ne 1) {
  Bad "録音デバイス Voicemeeter Out B1 を一意に解決できません（候補 $($b1Candidates.Count) 件）"
  $preflightBlocked = $true
}
if ($micCandidates.Count -ne 1) {
  Bad "物理マイク '$Mic' を一意に解決できません（候補 $($micCandidates.Count) 件）"
  $preflightBlocked = $true
}
if (-not $preflightBlocked) {
  Info "録音 既定の通信 | 変更前: $recComm | 要求値: $($b1Candidates[0].Name)"
  Info "VoiceMeeter IN1  | 要求値: $($micCandidates[0].Name)"
}
if ($Fix) {
  if ($preflightBlocked) { Info 'プリフライト失敗のため変更しません'; exit 2 }
}

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
$requiredBlocked = $false
foreach ($r in $required) {
  $d = @(Get-EndpointState $r.Flow $r.Pattern)
  if ($d.Count -eq 0) {
    Bad "$($r.Pattern) が存在しない（$($r.Why)）"
    $requiredBlocked = $true
  } elseif (@($d | Where-Object { $_.State -eq 1 }).Count -ne 1) {
    Bad "$($r.Pattern) の有効候補を一意に解決できない（$($r.Why)）"
    $requiredBlocked = $true
  } else {
    Ok "$($d[0].Name) : 有効（$($r.Why)）"
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
  public static string GetStr(string p) { var sb = new StringBuilder(1024); var rc = VBVMR_GetParameterStringW(p, sb); if (rc < 0) throw new InvalidOperationException(p + " read failed: " + rc); return sb.ToString(); }
  public static float GetF(string p) { float v = 0; var rc = VBVMR_GetParameterFloat(p, ref v); if (rc < 0) throw new InvalidOperationException(p + " read failed: " + rc); return v; }
  public static float Level(int t, int c) { float v = 0; var rc = VBVMR_GetLevel(t, c, ref v); if (rc < 0) throw new InvalidOperationException("level read failed: " + rc); return v; }
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
    if ($requiredBlocked) {
      Info '必要な仮想デバイスを一意に解決できないため変更しません'
      [void][VMR]::VBVMR_Logout()
      exit 2
    }
    $steps = @(
      @{ Name = '録音 既定の通信'; Before = $recComm; Requested = $b1Candidates[0].Name; Apply = { [AudioDef]::SetDefault($b1Candidates[0].Id, 2) }; Read = { [AudioDef]::GetDefault(1, 2) } },
      @{ Name = 'VoiceMeeter IN1'; Before = $in1; Requested = $micCandidates[0].Name; Apply = { [VMR]::VBVMR_SetParameterStringW('Strip[0].device.wdm', $micCandidates[0].Name) }; Read = { [VMR]::GetStr('Strip[0].device.name') } },
      @{ Name = 'IN1 A1'; Before = [int]$in1A1; Requested = 0; Apply = { [VMR]::VBVMR_SetParameterFloat('Strip[0].A1', 0) }; Read = { [int][VMR]::GetF('Strip[0].A1') } },
      @{ Name = 'IN1 B1'; Before = [int]$in1B1; Requested = 1; Apply = { [VMR]::VBVMR_SetParameterFloat('Strip[0].B1', 1) }; Read = { [int][VMR]::GetF('Strip[0].B1') } },
      @{ Name = 'IN1 mute'; Before = [int]$in1Mute; Requested = 0; Apply = { [VMR]::VBVMR_SetParameterFloat('Strip[0].mute', 0) }; Read = { [int][VMR]::GetF('Strip[0].mute') } },
      @{ Name = 'Virtual Input A1'; Before = [int]$vioA1; Requested = 0; Apply = { [VMR]::VBVMR_SetParameterFloat('Strip[2].A1', 0) }; Read = { [int][VMR]::GetF('Strip[2].A1') } },
      @{ Name = 'Virtual Input B1'; Before = [int]$vioB1; Requested = 1; Apply = { [VMR]::VBVMR_SetParameterFloat('Strip[2].B1', 1) }; Read = { [int][VMR]::GetF('Strip[2].B1') } }
    )
    $fixFailed = $false
    $changed = $false
    foreach ($step in $steps) {
      if ($fixFailed) {
        Info "$($step.Name) | 変更前: $($step.Before) | 要求値: $($step.Requested) | 変更後: 不明 | 結果: 未実行"
        continue
      }
      if ([string]$step.Before -eq [string]$step.Requested) {
        Info "$($step.Name) | 変更前: $($step.Before) | 要求値: $($step.Requested) | 変更後: $($step.Before) | 結果: 変更不要"
        continue
      }
      try {
        $code = & $step.Apply
        if ($code -lt 0) { throw "設定APIが失敗しました (code=$code)" }
        $after = '不明'
        $matched = $false
        foreach ($attempt in 1..10) {
          # VoiceMeeter は dirty 通知を一度取り込んでから再読込する。Core Audio の
          # 既定デバイスも同じ有界再試行に載せ、反映遅延を固定 sleep で決め打ちしない。
          if ($step.Name -ne '録音 既定の通信') {
            $dirtyCode = [VMR]::VBVMR_IsParametersDirty()
            if ($dirtyCode -lt 0) { throw "VoiceMeeter 同期に失敗しました (code=$dirtyCode)" }
          }
          try { $after = & $step.Read } catch { $after = '不明' }
          if ([string]$after -like "*$($step.Requested)*") { $matched = $true; break }
          Start-Sleep -Milliseconds 100
        }
        if (-not $matched) { throw "適用後の実値が要求値と一致しません (code=$code)" }
        $changed = $true
        Info "$($step.Name) | 変更前: $($step.Before) | 要求値: $($step.Requested) | 変更後: $after | 結果: 変更済み"
      } catch {
        $after = try { & $step.Read } catch { '不明' }
        Bad "$($step.Name) | 変更前: $($step.Before) | 要求値: $($step.Requested) | 変更後: $after | 結果: 失敗 ($($_.Exception.Message))"
        $fixFailed = $true
      }
    }
    if ($fixFailed) {
      [void][VMR]::VBVMR_Logout()
      Write-Host "結果: 部分成功。再実行すると一致済み項目は変更しません" -ForegroundColor Red
      exit 3
    }
    if ($changed) {
      Start-Sleep -Milliseconds 400
      $restartCode = [VMR]::VBVMR_SetParameterFloat('Command.Restart', 1)
      if ($restartCode -lt 0) {
        [void][VMR]::VBVMR_Logout()
        Bad "VoiceMeeter の再起動要求に失敗しました (code=$restartCode)"
        exit 3
      }
      Start-Sleep -Seconds 3
    } else {
      Info '全項目が要求値と一致しているため、VoiceMeeter は再起動しません'
    }
    [void][VMR]::VBVMR_Logout()
    Write-Host "`n修復後の状態を再診断します" -ForegroundColor Cyan
    & $PSCommandPath -Mic $Mic -VoiceApp $VoiceApp -LevelSeconds $LevelSeconds
    exit $LASTEXITCODE
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
    Ok "B1 に声が乗っています。VoiceMeeter出力までは正常です"
    Info "これはChatGPT内部の選択マイクやリモート往復を証明しません。最後にリモート参加者だけで応答を確認してください"
  }

  [void][VMR]::VBVMR_Logout()
}

# ────────────────────────────────────────────────────────────────
# 6. ChatGPT アプリ側
# ────────────────────────────────────────────────────────────────
Head "6. ChatGPT アプリ"
# この PC には ChatGPT 系アプリが2つ入っている。音声対話に使うのは既定で
# 'ChatGPT Classic'、'ChatGPT' の方は Codex。**両方起動しているのが正常**で、
# 事故は「どちらのアプリを設定したか」を取り違えたときに起きる。
$voice = @(Get-Process -Name $VoiceApp -ErrorAction SilentlyContinue)
$others = @(
  Get-Process -Name 'ChatGPT', 'ChatGPT Classic' -ErrorAction SilentlyContinue |
    Where-Object { $_.ProcessName -ne $VoiceApp } |
    Select-Object -ExpandProperty ProcessName -Unique
)
if ($voice.Count -gt 0) {
  Ok "$VoiceApp 起動中（音声対話はこちら）"
} else {
  Bad "$VoiceApp が起動していない（音声対話に使うアプリ）"
  Info "別のアプリを使っているなら -VoiceApp '<プロセス名>' を付けて実行する"
}
if ($others.Count -gt 0) {
  Info "同時に起動: $($others -join ', ')（音声とは無関係。終了させる必要はない）"
  Info "音量ミキサーで出力デバイスを設定するのは『$VoiceApp』の行。別アプリの行を触っても効かない"
}
Info "確認: 音声モードのマイクボタンにカーソルを合わせると Communications - <デバイス名> が出る"
Info "ChatGPT内部で明示マイクが選ばれている場合は Voicemeeter Out B1 を選ぶ（このスクリプトからは変更できません）"
Info "既定の通信デバイスを変えたら $VoiceApp はタスクトレイからも完全終了して再起動する"

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

if ($script:Fail -gt 0) { exit 1 }
