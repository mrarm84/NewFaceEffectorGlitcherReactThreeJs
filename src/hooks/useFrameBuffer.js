// useFrameBuffer.js — Records canvas snapshots and plays them back as a loop.
import { useRef, useState, useCallback } from 'react';

export function useFrameBuffer() {
  const framesRef   = useRef([]);
  const playIdxRef  = useRef(0);
  const [mode, setMode]     = useState('idle');   // 'idle' | 'recording' | 'playing'
  const [bufSize, setBufSize] = useState(30);

  const record = useCallback(() => {
    framesRef.current = [];
    playIdxRef.current = 0;
    setMode('recording');
    window.FRAME_BUF_MODE = 'recording';
  }, []);

  const play = useCallback(() => {
    if (!framesRef.current.length) return;
    playIdxRef.current = 0;
    setMode('playing');
    window.FRAME_BUF_MODE = 'playing';
  }, []);

  const stop = useCallback(() => {
    setMode('idle');
    window.FRAME_BUF_MODE = 'idle';
  }, []);

  // Called by EffectsCanvas each frame during 'recording'
  const pushFrame = useCallback((canvas) => {
    const fc = document.createElement('canvas');
    fc.width = canvas.width; fc.height = canvas.height;
    fc.getContext('2d').drawImage(canvas, 0, 0);
    framesRef.current.push(fc);
    if (framesRef.current.length >= bufSize) {
      playIdxRef.current = 0;
      setMode('playing');
      window.FRAME_BUF_MODE = 'playing';
    }
    return framesRef.current.length;
  }, [bufSize]);

  // Called by EffectsCanvas each frame during 'playing'; returns the canvas to draw
  const nextFrame = useCallback(() => {
    if (!framesRef.current.length) return null;
    playIdxRef.current = (playIdxRef.current + 1) % framesRef.current.length;
    return framesRef.current[playIdxRef.current];
  }, []);

  return {
    framesRef, playIdxRef, mode, bufSize, setBufSize,
    record, play, stop, pushFrame, nextFrame,
    count: () => framesRef.current.length,
  };
}
