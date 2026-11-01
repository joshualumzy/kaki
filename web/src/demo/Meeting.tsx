import { useState } from 'react';
import { LiveKitRoom } from '@livekit/components-react';
import '@livekit/components-styles';
import { PhoneFeed } from '../phone/PhonePage';
import { ErrorBoundary } from './ErrorBoundary';
import { MeetingGrid } from './MeetingGrid';
import { LocalSpeechSTT } from './LocalSpeechSTT';

export default function Meeting() {
  const [token, setToken] = useState<string>('');
  const [preJoinComplete, setPreJoinComplete] = useState(false);
  const [name, setName] = useState('');
  const [role, setRole] = useState('Producer');

  const handleJoin = async () => {
    if (!name.trim()) return;
    try {
      // Request mic permissions before joining
      await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      
      const res = await fetch('/api/livekit/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          roomName: 'HawkerHeroesLaunch', 
          participantName: name.trim(),
          participantRole: role 
        }),
      });
      const data = await res.json();
      setToken(data.token);
      setPreJoinComplete(true);
    } catch (e) {
      console.error(e);
      alert("Microphone permission is required to join the meeting.");
    }
  };

  if (!preJoinComplete || !token) {
    return (
      <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: '#0f172a', fontFamily: 'system-ui, sans-serif' }}>
        <div style={{ backgroundColor: '#1e293b', padding: '40px', borderRadius: '16px', width: '450px', boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)' }}>
          <h1 style={{ color: 'white', margin: '0 0 8px 0', fontSize: '24px', fontWeight: '600' }}>Join Meeting</h1>
          <p style={{ color: '#94a3b8', margin: '0 0 32px 0', fontSize: '14px' }}>Hawker Heroes Launch Readiness</p>
          
          <div style={{ marginBottom: '24px' }}>
            <label style={{ display: 'block', color: '#cbd5e1', fontSize: '12px', fontWeight: '500', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Your Name</label>
            <input 
              type="text" 
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. Josh"
              style={{ width: '100%', padding: '12px 16px', backgroundColor: '#0f172a', border: '1px solid #334155', borderRadius: '8px', color: 'white', fontSize: '16px', outline: 'none', boxSizing: 'border-box' }}
              autoFocus
            />
          </div>

          <div style={{ marginBottom: '32px' }}>
            <label style={{ display: 'block', color: '#cbd5e1', fontSize: '12px', fontWeight: '500', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Your Role</label>
            <select 
              value={role}
              onChange={e => setRole(e.target.value)}
              style={{ width: '100%', padding: '12px 16px', backgroundColor: '#0f172a', border: '1px solid #334155', borderRadius: '8px', color: 'white', fontSize: '16px', outline: 'none', boxSizing: 'border-box', appearance: 'none' }}
            >
              <option value="Producer">Producer</option>
              <option value="Lead Designer">Lead Designer</option>
              <option value="QA Tester">QA Tester</option>
              <option value="CEO">CEO</option>
            </select>
          </div>

          <button 
            onClick={handleJoin}
            disabled={!name.trim()}
            style={{ width: '100%', padding: '14px', backgroundColor: name.trim() ? '#3b82f6' : '#334155', color: name.trim() ? 'white' : '#94a3b8', border: 'none', borderRadius: '8px', fontSize: '16px', fontWeight: '600', cursor: name.trim() ? 'pointer' : 'not-allowed', transition: 'background-color 0.2s' }}
          >
            Join with Microphone
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ height: '100vh', display: 'flex', overflow: 'hidden' }}>
      <div style={{ flex: 1, backgroundColor: '#000', position: 'relative' }}>
        <LiveKitRoom
          video={false}
          audio={true}
          token={token}
          serverUrl="ws://127.0.0.1:7880"
          onDisconnected={() => setPreJoinComplete(false)}
          data-lk-theme="default"
          style={{ height: '100%' }}
        >
          <ErrorBoundary><MeetingGrid /></ErrorBoundary>
          <LocalSpeechSTT participantName={name} />
        </LiveKitRoom>
      </div>
      <div style={{ width: '400px', backgroundColor: '#f9fafb', borderLeft: '1px solid #e5e7eb', overflowY: 'auto' }}>
        <div style={{ height: '100%', position: 'relative' }}>
           <ErrorBoundary><PhoneFeed role="producer" /></ErrorBoundary>
        </div>
      </div>
    </div>
  );
}
