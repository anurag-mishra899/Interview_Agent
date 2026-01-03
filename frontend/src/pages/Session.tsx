import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { InterviewWebSocket, WebSocketMessage } from '../services/websocket'
import { endSession, getSession } from '../services/api'
import AudioWaveform from '../components/AudioWaveform'
import Transcript from '../components/Transcript'
import SessionControls from '../components/SessionControls'

interface TranscriptEntry {
  role: 'user' | 'assistant'
  text: string
  timestamp: Date
}

export default function Session() {
  const { sessionId } = useParams<{ sessionId: string }>()
  const navigate = useNavigate()

  const [status, setStatus] = useState<string>('connecting')
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([])
  const [isMuted, setIsMuted] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const [sessionDuration, setSessionDuration] = useState(30) // Default 30 minutes

  // Session time limits (in seconds) - calculated from session duration
  const MAX_SESSION_SECONDS = sessionDuration * 60
  const WARNING_THRESHOLD = Math.floor(sessionDuration * 0.75) * 60  // Yellow at 75%
  const DANGER_THRESHOLD = Math.floor(sessionDuration * 0.9) * 60   // Red at 90%

  const wsRef = useRef<InterviewWebSocket | null>(null)
  const mediaStreamRef = useRef<MediaStream | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const processorRef = useRef<ScriptProcessorNode | null>(null)

  // Audio playback refs - single context with proper queuing
  const playbackContextRef = useRef<AudioContext | null>(null)
  const nextPlayTimeRef = useRef<number>(0)
  const activeSourcesRef = useRef<AudioBufferSourceNode[]>([])

  // Format seconds as MM:SS
  const formatTime = (seconds: number): string => {
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
  }

  // Get timer color based on elapsed time
  const getTimerColor = (): string => {
    if (elapsedSeconds >= DANGER_THRESHOLD) return 'text-red-400'
    if (elapsedSeconds >= WARNING_THRESHOLD) return 'text-yellow-400'
    return 'text-green-400'
  }

  // Calculate remaining time
  const remainingSeconds = Math.max(0, MAX_SESSION_SECONDS - elapsedSeconds)
  const progressPercent = Math.min(100, (elapsedSeconds / MAX_SESSION_SECONDS) * 100)
  const MAX_SESSION_MINUTES = Math.floor(MAX_SESSION_SECONDS / 60)

  // Timer effect
  useEffect(() => {
    const timer = setInterval(() => {
      setElapsedSeconds((prev) => prev + 1)
    }, 1000)

    return () => clearInterval(timer)
  }, [])

  // Fetch session details to get duration
  useEffect(() => {
    if (!sessionId) return

    getSession(parseInt(sessionId))
      .then((session) => {
        if (session.duration_minutes) {
          setSessionDuration(session.duration_minutes)
        }
      })
      .catch((err) => {
        console.error('Failed to fetch session details:', err)
      })
  }, [sessionId])

  // Stop all playing audio (for interruption)
  const stopAllAudio = useCallback(() => {
    activeSourcesRef.current.forEach((source) => {
      try {
        source.stop()
      } catch (e) {
        // Source may have already stopped
      }
    })
    activeSourcesRef.current = []
    nextPlayTimeRef.current = 0
  }, [])

  const handleMessage = useCallback((message: WebSocketMessage) => {
    switch (message.type) {
      case 'status':
        setStatus(message.status || 'unknown')
        // Clear error on successful connection
        if (message.status === 'connected' || message.status === 'listening') {
          setError(null)
        }
        // Stop all audio and reset queue when user starts speaking (interruption)
        if (message.status === 'speaking') {
          stopAllAudio()
        }
        break
      case 'transcript':
        if (message.role && message.text) {
          setTranscript((prev) => [
            ...prev,
            {
              role: message.role as 'user' | 'assistant',
              text: message.text,
              timestamp: new Date(),
            },
          ])
        }
        break
      case 'audio':
        // Handle incoming audio from AI
        if (message.data) {
          playAudio(message.data)
        }
        break
      case 'error':
        setError(message.message || 'Unknown error')
        break
    }
  }, [stopAllAudio])

  const playAudio = async (base64Audio: string) => {
    try {
      // Initialize playback context once (reuse for all chunks)
      if (!playbackContextRef.current) {
        playbackContextRef.current = new AudioContext({ sampleRate: 24000 })
        nextPlayTimeRef.current = 0
      }

      const audioContext = playbackContextRef.current

      // Resume context if suspended (browser autoplay policy)
      if (audioContext.state === 'suspended') {
        await audioContext.resume()
      }

      // Decode base64 to bytes
      const audioData = atob(base64Audio)
      const view = new Uint8Array(audioData.length)
      for (let i = 0; i < audioData.length; i++) {
        view[i] = audioData.charCodeAt(i)
      }

      // Convert PCM16 signed little-endian to Float32
      const numSamples = view.length / 2
      const audioBuffer = audioContext.createBuffer(1, numSamples, 24000)
      const channelData = audioBuffer.getChannelData(0)

      for (let i = 0; i < numSamples; i++) {
        // Read as signed 16-bit little-endian
        let sample = view[i * 2] | (view[i * 2 + 1] << 8)
        // Convert to signed (handle negative values)
        if (sample >= 0x8000) {
          sample -= 0x10000
        }
        // Normalize to -1.0 to 1.0
        channelData[i] = sample / 32768
      }

      // Schedule audio to play seamlessly after previous chunk
      const source = audioContext.createBufferSource()
      source.buffer = audioBuffer

      // Add a small gain to ensure audibility
      const gainNode = audioContext.createGain()
      gainNode.gain.value = 1.0
      source.connect(gainNode)
      gainNode.connect(audioContext.destination)

      // Calculate start time - schedule after previous audio ends
      const currentTime = audioContext.currentTime
      const startTime = Math.max(currentTime, nextPlayTimeRef.current)

      // Track active source for interruption
      activeSourcesRef.current.push(source)
      source.onended = () => {
        const index = activeSourcesRef.current.indexOf(source)
        if (index > -1) {
          activeSourcesRef.current.splice(index, 1)
        }
      }

      source.start(startTime)

      // Update next play time for seamless playback
      nextPlayTimeRef.current = startTime + audioBuffer.duration
    } catch (e) {
      console.error('Failed to play audio:', e)
    }
  }

  useEffect(() => {
    if (!sessionId) return

    // Prevent double connection from React StrictMode
    if (wsRef.current) {
      return // Already connected
    }

    // Connect WebSocket
    const ws = new InterviewWebSocket(parseInt(sessionId), handleMessage)
    wsRef.current = ws
    ws.connect()

    // Set up audio capture
    setupAudioCapture()

    return () => {
      // Only cleanup if this is the same websocket we created
      if (wsRef.current === ws) {
        ws.disconnect()
        wsRef.current = null
        stopAudioCapture()
        // Stop all playing audio
        activeSourcesRef.current.forEach((source) => {
          try { source.stop() } catch (e) { /* ignore */ }
        })
        activeSourcesRef.current = []
        // Cleanup playback context
        if (playbackContextRef.current) {
          playbackContextRef.current.close()
          playbackContextRef.current = null
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  const setupAudioCapture = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: 24000,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      })
      mediaStreamRef.current = stream

      audioContextRef.current = new AudioContext({ sampleRate: 24000 })
      const source = audioContextRef.current.createMediaStreamSource(stream)

      // Use ScriptProcessorNode for simplicity (deprecated but widely supported)
      processorRef.current = audioContextRef.current.createScriptProcessor(4096, 1, 1)

      processorRef.current.onaudioprocess = (e) => {
        if (isMuted || !wsRef.current?.isConnected()) return

        const inputData = e.inputBuffer.getChannelData(0)
        const pcm16 = new Int16Array(inputData.length)

        for (let i = 0; i < inputData.length; i++) {
          pcm16[i] = Math.max(-32768, Math.min(32767, inputData[i] * 32768))
        }

        wsRef.current?.sendAudio(pcm16.buffer)
      }

      source.connect(processorRef.current)
      processorRef.current.connect(audioContextRef.current.destination)
    } catch (e) {
      setError('Failed to access microphone. Please grant permission.')
    }
  }

  const stopAudioCapture = () => {
    processorRef.current?.disconnect()
    audioContextRef.current?.close()
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop())
  }

  const handleMuteToggle = () => {
    setIsMuted(!isMuted)
    wsRef.current?.sendControl(isMuted ? 'unmute' : 'mute')
  }

  const handleEndSession = async () => {
    if (!sessionId) return

    try {
      wsRef.current?.sendControl('end')
      wsRef.current?.disconnect()
      await endSession(parseInt(sessionId))
      navigate(`/report/${sessionId}`)
    } catch (e) {
      // Session may have ended already, navigate anyway
      navigate(`/report/${sessionId}`)
    }
  }

  return (
    <div className="h-screen bg-gray-900 flex flex-col overflow-hidden">
      {/* Header */}
      <header className="bg-gray-800 px-4 py-3 flex-shrink-0">
        <div className="flex items-center justify-between">
          <h1 className="text-white font-semibold">Interview Session</h1>

          {/* Timer Display */}
          <div className="flex items-center space-x-4">
            <div className="flex items-center space-x-2 bg-gray-700 px-3 py-1 rounded-lg">
              <svg className={`w-4 h-4 ${getTimerColor()}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span className={`font-mono text-lg font-semibold ${getTimerColor()}`}>
                {formatTime(elapsedSeconds)}
              </span>
              <span className="text-gray-500 text-xs">
                / {MAX_SESSION_MINUTES}:00
              </span>
            </div>

            {/* Status Indicator */}
            <div className="flex items-center space-x-2">
              <span
                className={`w-2 h-2 rounded-full ${
                  status === 'connected' || status === 'listening'
                    ? 'bg-green-500'
                    : status === 'speaking'
                    ? 'bg-yellow-500'
                    : 'bg-red-500'
                }`}
              />
              <span className="text-gray-300 text-sm capitalize">{status}</span>
            </div>
          </div>
        </div>

        {/* Progress Bar */}
        <div className="mt-2 h-1 bg-gray-700 rounded-full overflow-hidden">
          <div
            className={`h-full transition-all duration-1000 ${
              elapsedSeconds >= DANGER_THRESHOLD
                ? 'bg-red-500'
                : elapsedSeconds >= WARNING_THRESHOLD
                ? 'bg-yellow-500'
                : 'bg-green-500'
            }`}
            style={{ width: `${progressPercent}%` }}
          />
        </div>
      </header>

      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left Panel - Audio Visualization */}
        <div className="w-1/2 flex flex-col items-center justify-center p-8 border-r border-gray-700 overflow-hidden">
          <AudioWaveform isActive={status === 'speaking' || status === 'listening'} />

          {error && (
            <div className="mt-4 text-red-400 text-sm">{error}</div>
          )}

          <SessionControls
            isMuted={isMuted}
            onMuteToggle={handleMuteToggle}
            onEndSession={handleEndSession}
          />
        </div>

        {/* Right Panel - Transcript */}
        <div className="w-1/2 flex flex-col bg-gray-800 overflow-hidden">
          <div className="p-4 border-b border-gray-700 flex-shrink-0">
            <h2 className="text-white font-medium">Live Transcript</h2>
          </div>
          <div className="flex-1 overflow-hidden">
            <Transcript entries={transcript} />
          </div>
        </div>
      </div>
    </div>
  )
}
