class PulseWebRTCEngine {
  constructor(onStateChange) {
    this.onStateChange = onStateChange || (() => {});
    this.activeChannelId = null;
    this.activeServerId = null;
    this.connectionStatus = 'disconnected';
    this.pingMs = null;
    this.isMuted = false;
    this.isDeafened = false;
    this.isVideoEnabled = false;
    this.isScreenSharing = false;
    this.isSpeaking = false;
    this.audioVolumeLevel = 0;
    this.audioInputs = [];
    this.audioOutputs = [];
    this.videoInputs = [];
    this.selectedAudioInput = 'default';
    this.selectedAudioOutput = 'default';
    this.selectedVideoInput = 'default';
    this.room = null;
    this.canSpeak = false;
    this.canStream = false;
    this.remoteVideoTracks = new Map();
    this.audioElements = new Map();
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.reconnectInProgress = false;
  }

  notify() { this.onStateChange(this); }

  async enumerateHardwareDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) return { audioInputs: [], audioOutputs: [], videoInputs: [] };
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      this.audioInputs = devices.filter((d) => d.kind === 'audioinput');
      this.audioOutputs = devices.filter((d) => d.kind === 'audiooutput');
      this.videoInputs = devices.filter((d) => d.kind === 'videoinput');
    } catch (error) { console.warn('Device enumeration failed:', error); }
    return { audioInputs: this.audioInputs, audioOutputs: this.audioOutputs, videoInputs: this.videoInputs };
  }

  async joinVoiceChannel(serverId, channelId, options = { withVideo: false }) {
    if (this.room && this.activeChannelId === channelId && this.connectionStatus === 'connected') {
      if (options.withVideo && this.canStream) await this.toggleCamera(true);
      return;
    }
    if (this.room) await this.leaveVoiceChannel();
    if (!window.PulseLiveKit?.Room) throw new Error('LiveKit client bundle is unavailable; voice cannot connect.');
    this.connectionStatus = 'connecting';
    this.activeServerId = serverId;
    this.activeChannelId = channelId;
    this.notify();
    try {
      await this.enumerateHardwareDevices();
      const result = await window.pulseAPI.request('/api/voice/token', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channelId })
      });
      this.canSpeak = Boolean(result.permissions?.canSpeak);
      this.canStream = Boolean(result.permissions?.canStream);
      const { Room, RoomEvent } = window.PulseLiveKit;
      const room = new Room({ adaptiveStream: true, dynacast: true, disconnectOnPageLeave: true });
      this.room = room;
      room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => this.onTrackSubscribed(track, publication, participant));
      room.on(RoomEvent.TrackUnsubscribed, (track, publication, participant) => this.onTrackUnsubscribed(track, publication, participant));
      room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
        this.isSpeaking = speakers.some((p) => p.identity === room.localParticipant.identity);
        this.notify();
      });
      room.on(RoomEvent.ConnectionStateChanged, (state) => {
        this.connectionStatus = state === 'signalReconnecting' ? 'reconnecting' : state;
        this.notify();
      });
      room.on(RoomEvent.Disconnected, () => {
        if (this.room !== room) return;
        const serverId = this.activeServerId, channelId = this.activeChannelId;
        this.room = null;
        for (const audio of this.audioElements.values()) { audio.pause(); audio.srcObject = null; audio.remove(); }
        this.audioElements.clear();
        this.remoteVideoTracks.clear();
        this.isVideoEnabled = false;
        this.isScreenSharing = false;
        if (serverId && channelId) {
          this.connectionStatus = 'reconnecting';
          this.scheduleReconnect(serverId, channelId);
        } else this.connectionStatus = 'disconnected';
        this.notify();
      });
      room.on(RoomEvent.LocalTrackUnpublished, (_publication, participant) => {
        if (this.room === room && participant === room.localParticipant) {
          if (_publication.source === window.PulseLiveKit.Track.Source.Camera) this.isVideoEnabled = false;
          if (_publication.source === window.PulseLiveKit.Track.Source.ScreenShare) this.isScreenSharing = false;
          this.notify('local-track-unpublished');
        }
      });
      await room.connect(result.url, result.token, { autoSubscribe: true });
      this.reconnectAttempts = 0;
      try { await room.switchActiveDevice('audiooutput', this.selectedAudioOutput); }
      catch (error) { console.warn('Could not apply the selected audio output device:', error); }
      if (this.canSpeak) {
        const audioOptions = this.selectedAudioInput === 'default' ? undefined : { deviceId: this.selectedAudioInput, echoCancellation: true, noiseSuppression: true, autoGainControl: true };
        try { await room.localParticipant.setMicrophoneEnabled(true, audioOptions); this.isMuted = false; }
        catch (error) { this.isMuted = true; this.notify('microphone-unavailable'); console.warn('Microphone unavailable; staying connected as listener:', error); }
      } else {
        this.isMuted = true;
      }
      this.connectionStatus = 'connected';
      if (options.withVideo && this.canStream) await this.toggleCamera(true);
      this.notify();
    } catch (error) {
      await this.leaveVoiceChannel(this.reconnectInProgress);
      throw error;
    }
  }

  onTrackSubscribed(track, publication, participant) {
    const Track = window.PulseLiveKit.Track;
    if (track.kind === Track.Kind.Audio) {
      const audio = track.attach();
      audio.autoplay = true;
      audio.playsInline = true;
      audio.muted = this.isDeafened;
      audio.dataset.livekitIdentity = participant.identity;
      document.body.appendChild(audio);
      this.audioElements.set(`${participant.identity}:${publication.trackSid}`, audio);
    } else if (track.kind === Track.Kind.Video) {
      const source = publication.source || track.source;
      if (source === Track.Source.ScreenShare) this.remoteVideoTracks.set(`screen:${participant.identity}`, track);
      else this.remoteVideoTracks.set(`camera:${participant.identity}`, track);
    }
    this.notify();
  }

  onTrackUnsubscribed(track, publication, participant) {
    const key = `${participant.identity}:${publication.trackSid}`;
    const audio = this.audioElements.get(key);
    if (audio) { track.detach(audio); audio.remove(); this.audioElements.delete(key); }
    if (track.kind === window.PulseLiveKit.Track.Kind.Video) {
      track.detach();
      const prefix = publication.source === window.PulseLiveKit.Track.Source.ScreenShare ? 'screen' : 'camera';
      this.remoteVideoTracks.delete(`${prefix}:${participant.identity}`);
    }
    this.notify();
  }

  scheduleReconnect(serverId, channelId) {
    if (this.reconnectAttempts >= 5) {
      this.connectionStatus = 'disconnected';
      this.activeChannelId = null;
      this.activeServerId = null;
      this.notify();
      return;
    }
    const delay = Math.min(30000, 1000 * (2 ** this.reconnectAttempts));
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectInProgress = true;
      try { await this.joinVoiceChannel(serverId, channelId); this.reconnectInProgress = false; }
      catch (error) {
        this.reconnectInProgress = false;
        console.warn('LiveKit reconnect attempt failed:', error.message);
        this.activeServerId = serverId;
        this.activeChannelId = channelId;
        this.connectionStatus = 'reconnecting';
        this.notify();
        this.scheduleReconnect(serverId, channelId);
      }
    }, delay);
  }

  attachRemoteVideo(identity, element, source = 'camera') {
    const track = this.remoteVideoTracks.get(`${source}:${identity}`);
    if (!track || !element || element.dataset.attached === 'true') return;
    track.attach(element);
    element.dataset.attached = 'true';
  }

  async leaveVoiceChannel(preserveRetry = false) {
    if (!preserveRetry) {
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      this.reconnectAttempts = 0;
    }
    const room = this.room;
    this.room = null;
    if (room) {
      try { await room.disconnect(); } catch (error) { console.warn('LiveKit disconnect warning:', error); }
    }
    for (const audio of this.audioElements.values()) { audio.pause(); audio.srcObject = null; audio.remove(); }
    this.audioElements.clear();
    this.remoteVideoTracks.clear();
    this.activeChannelId = null;
    this.activeServerId = null;
    this.connectionStatus = 'disconnected';
    this.isMuted = false;
    this.isDeafened = false;
    this.isVideoEnabled = false;
    this.isScreenSharing = false;
    this.isSpeaking = false;
    this.pingMs = null;
    this.notify();
  }

  async toggleMute() {
    if (!this.room) throw new Error('Join a voice channel first.');
    if (!this.canSpeak) throw new Error('Your role does not allow microphone publishing.');
    this.isMuted = !this.isMuted;
    await this.room.localParticipant.setMicrophoneEnabled(!this.isMuted);
    this.notify();
    return this.isMuted;
  }

  toggleDeafen() {
    if (!this.room) throw new Error('Join a voice channel first.');
    this.isDeafened = !this.isDeafened;
    for (const audio of this.audioElements.values()) audio.muted = this.isDeafened;
    this.notify();
    return this.isDeafened;
  }

  async toggleCamera(forceState) {
    if (!this.room) throw new Error('Join a voice channel first.');
    const target = typeof forceState === 'boolean' ? forceState : !this.isVideoEnabled;
    if (target && !this.canStream) throw new Error('Your role does not allow camera or screen sharing.');
    const { VideoPresets } = window.PulseLiveKit;
    await this.room.localParticipant.setCameraEnabled(target, target ? { resolution: VideoPresets.h720.resolution, deviceId: this.selectedVideoInput === 'default' ? undefined : this.selectedVideoInput } : undefined);
    this.isVideoEnabled = target;
    this.notify();
    return { enabled: target, mode: 'livekit' };
  }

  async toggleScreenShare() {
    if (!this.room) throw new Error('Join a voice channel first.');
    if (!this.canStream) throw new Error('Your role does not allow camera or screen sharing.');
    const target = !this.isScreenSharing;
    await this.room.localParticipant.setScreenShareEnabled(target, target ? { audio: true } : undefined);
    this.isScreenSharing = target;
    this.notify();
    return { sharing: target, mode: 'livekit' };
  }

  async startSyntheticScreenShareDemo() {
    throw new Error('Synthetic/demo screen sharing has been removed. Use Share Screen to publish a real capture.');
  }
}
window.PulseWebRTCEngine = PulseWebRTCEngine;
