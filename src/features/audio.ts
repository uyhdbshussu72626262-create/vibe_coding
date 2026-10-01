import type { SoundPreset } from '../types';

export type { SoundPreset };

export interface SoundOption {
  id: SoundPreset;
  label: string;
  labelEn: string;
  file: string;
}

const ALARM_FILE =
  '/audio/zapsplat_pack_bell_alarm_clock_mp3/zapsplat_pack_bell_alarm_clock_mp3/zapsplat_household_alarm_clock_old_fashioned_ring_long_44059.mp3';

export const SOUND_OPTIONS: SoundOption[] = [
  { id: 'off', label: '关闭', labelEn: 'Off', file: '' },
  {
    id: 'rain',
    label: '雷雨雨声',
    labelEn: 'Thunderstorm rain',
    file: '/audio/mixkit-calm-thunderstorm-in-the-jungle-2415.wav',
  },
  {
    id: 'clock',
    label: '钟表声',
    labelEn: 'Clock ticking',
    file: '/audio/felix_blume_household_wall_clock_ticking.mp3',
  },
  {
    id: 'water',
    label: '水下氛围',
    labelEn: 'Deep water ambience',
    file: '/audio/mixkit-diving-in-deep-water-1312.wav',
  },
];

class AudioMixer {
  private audioElement: HTMLAudioElement | null = null;
  private current: SoundPreset = 'off';
  private currentVolume = 0.45;

  get preset(): SoundPreset {
    return this.current;
  }

  async play(preset: SoundPreset, volume = this.currentVolume): Promise<void> {
    this.stop();
    this.current = preset;
    this.currentVolume = Math.max(0, Math.min(1, volume));
    const option = SOUND_OPTIONS.find((item) => item.id === preset);
    if (!option || !option.file) return;

    const audio = new Audio(option.file);
    audio.loop = true;
    audio.volume = this.currentVolume;
    this.audioElement = audio;
    try {
      await audio.play();
    } catch {
      // 文件不存在或浏览器阻止播放时保持关闭，不再使用内置合成音。
      this.stop();
    }
  }

  stop(): void {
    this.current = 'off';
    if (this.audioElement) {
      this.audioElement.pause();
      this.audioElement.currentTime = 0;
      this.audioElement = null;
    }
  }

  setVolume(volume: number): void {
    this.currentVolume = Math.max(0, Math.min(1, volume));
    if (this.audioElement) this.audioElement.volume = this.currentVolume;
  }

  async playAlarm(): Promise<void> {
    const alarm = new Audio(ALARM_FILE);
    alarm.volume = Math.max(0.4, this.currentVolume);
    try {
      await alarm.play();
    } catch {
      // 铃声文件不可用时保持静音，不使用合成提示音。
    }
  }
}

export const audioMixer = new AudioMixer();
