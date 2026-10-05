import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Speak instead of type, into any text box.
 *
 * Uses the browser's own speech recognition (Chrome, Edge, Safari), so there is no
 * model or key to configure. Words appear in the box as they are recognised and the
 * person can correct them before sending -- dictation fills the box, it never sends.
 *
 * Two browser rules shape the errors below: the microphone is only offered on a
 * secure page (HTTPS or localhost), and Chrome and Edge recognise speech on their
 * vendor's servers, so they need an internet connection.
 */

interface Alternative { transcript: string }
interface Result { isFinal: boolean; 0: Alternative }
interface ResultEvent { resultIndex: number; results: ArrayLike<Result> }
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: ResultEvent) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type RecognitionCtor = new () => Recognition;

function recognitionCtor(): RecognitionCtor | undefined {
  if (typeof window === 'undefined') return undefined;
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

const ERRORS: Record<string, string> = {
  'not-allowed': 'Microphone access is blocked. Allow it for this site in the browser, then try again.',
  'service-not-allowed': 'This browser does not allow speech recognition here.',
  'audio-capture': 'No microphone was found.',
  network: 'Speech recognition in this browser needs an internet connection.',
  'no-speech': 'Did not hear anything. Try again.',
  'language-not-supported': 'Your browser language is not supported for voice input.',
};

/** Join two pieces of recognised text with exactly one space. */
const join = (a: string, b: string) => (a && b ? `${a.replace(/\s+$/, '')} ${b.replace(/^\s+/, '')}` : a + b);

export interface Dictation {
  /** The browser can recognise speech at all. */
  supported: boolean;
  listening: boolean;
  error: string | null;
  toggle: () => void;
  /** Stop and drop anything still being recognised (call before sending). */
  cancel: () => void;
}

export function useDictation(value: string, onChange: (v: string) => void): Dictation {
  const Ctor = recognitionCtor();
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rec = useRef<Recognition | null>(null);
  // Latest props, read inside the recognition callbacks without restarting them.
  const valueRef = useRef(value);
  valueRef.current = value;
  const changeRef = useRef(onChange);
  changeRef.current = onChange;

  const cancel = useCallback(() => {
    const r = rec.current;
    rec.current = null;
    if (r) {
      r.onresult = null;
      r.abort();
    }
    setListening(false);
  }, []);

  const start = useCallback(() => {
    if (!Ctor) return;
    if (!window.isSecureContext) {
      setError('Voice input needs SupOps to be opened over HTTPS (or on localhost).');
      return;
    }
    setError(null);
    const r = new Ctor();
    r.lang = navigator.language || 'en-US';
    r.continuous = true;
    r.interimResults = true;

    let base = valueRef.current;
    let spoken = '';
    let written = base;
    r.onresult = (e) => {
      // Typed into the box mid-dictation: keep their edit and carry on after it.
      if (valueRef.current !== written) {
        base = valueRef.current;
        spoken = '';
      }
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i]!;
        if (res.isFinal) spoken = join(spoken, res[0].transcript.trim());
        else interim = join(interim, res[0].transcript.trim());
      }
      written = join(base, join(spoken, interim));
      // Ahead of the re-render, so a second result before it is not taken for an edit.
      valueRef.current = written;
      changeRef.current(written);
    };
    r.onerror = (e) => {
      if (e.error !== 'aborted') setError(ERRORS[e.error] ?? `Voice input stopped (${e.error}).`);
    };
    r.onend = () => {
      if (rec.current === r) rec.current = null;
      setListening(false);
    };
    rec.current = r;
    try {
      r.start();
      setListening(true);
    } catch {
      rec.current = null;
      setError('Could not start voice input.');
    }
  }, [Ctor]);

  const toggle = useCallback(() => {
    if (rec.current) rec.current.stop();
    else start();
  }, [start]);

  useEffect(() => () => rec.current?.abort(), []);

  return { supported: !!Ctor, listening, error, toggle, cancel };
}
