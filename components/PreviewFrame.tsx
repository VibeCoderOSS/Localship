import React, { useEffect, useRef, useState } from 'react';
import { PreviewStatus, ProjectFiles } from '../types';
import * as Babel from '@babel/standalone';
import { runPreviewPreflight } from '../utils/projectUtils';

interface PreviewFrameProps {
  files: ProjectFiles;
  isLoading: boolean;
  devMode: boolean; 
  lastGoodFallbackEnabled: boolean;
  onTestReport?: (report: any) => void;
  onPreviewStatus?: (status: PreviewStatus) => void;
}

interface ConsoleLog {
  type: 'log' | 'warn' | 'error' | 'info';
  content: string;
  timestamp: string;
}

interface UrlBundle {
  id: number;
  htmlUrl: string;
  urls: string[];
}

interface CleanupEntry {
  bundle: UrlBundle;
  enqueuedAt: number;
}

interface PreviewBanner {
  severity: 'warning' | 'error';
  stage: 'preflight' | 'compile' | 'mount' | 'smoke';
  message: string;
  details: string[];
}

const FALLBACK_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Preview</title></head><body><div id="root"></div></body></html>`;
const BUNDLE_REVOKE_GRACE_MS = 5000;

const PreviewFrame: React.FC<PreviewFrameProps> = ({
  files,
  isLoading,
  devMode,
  lastGoodFallbackEnabled,
  onTestReport,
  onPreviewStatus
}) => {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [pendingPreviewUrl, setPendingPreviewUrl] = useState<string | null>(null);
  const [compiledCss, setCompiledCss] = useState<string>('');
  const [previewBanner, setPreviewBanner] = useState<PreviewBanner | null>(null);
  const [showBannerDetails, setShowBannerDetails] = useState(false);
  const [logs, setLogs] = useState<ConsoleLog[]>([]);
  const [isConsoleExpanded, setIsConsoleExpanded] = useState(false);
  const vendorUrlsRef = useRef<string[]>([]);
  const currentRunIdRef = useRef(0);
  const currentRunErrorsRef = useRef<string[]>([]);
  const activeBundleRef = useRef<UrlBundle | null>(null);
  const stagedBundleRef = useRef<UrlBundle | null>(null);
  const lastGoodBundleRef = useRef<UrlBundle | null>(null);
  const cleanupQueueRef = useRef<CleanupEntry[]>([]);
  const pendingPreviousBundleRef = useRef<UrlBundle | null>(null);
  const rebuildTimerRef = useRef<number | null>(null);
  const [vendorMap, setVendorMap] = useState<Record<string, string> | null>(null);
  const consoleEndRef = useRef<HTMLDivElement>(null);
  const onPreviewStatusRef = useRef(onPreviewStatus);
  const onTestReportRef = useRef(onTestReport);
  const currentPreflightWarningsRef = useRef<string[]>([]);
  const currentAutoHealedRef = useRef<string[]>([]);

  useEffect(() => {
    onPreviewStatusRef.current = onPreviewStatus;
    onTestReportRef.current = onTestReport;
  }, [onPreviewStatus, onTestReport]);

  const enqueueBundleForCleanup = (bundle: UrlBundle | null) => {
    if (!bundle) return;
    const exists = cleanupQueueRef.current.some(entry => entry.bundle.htmlUrl === bundle.htmlUrl);
    if (exists) return;
    cleanupQueueRef.current.push({ bundle, enqueuedAt: Date.now() });
  };

  const flushStaleBundles = (force = false) => {
    const keep = new Set<string>();
    if (activeBundleRef.current) keep.add(activeBundleRef.current.htmlUrl);
    if (stagedBundleRef.current) keep.add(stagedBundleRef.current.htmlUrl);
    if (lastGoodBundleRef.current) keep.add(lastGoodBundleRef.current.htmlUrl);
    if (pendingPreviousBundleRef.current) keep.add(pendingPreviousBundleRef.current.htmlUrl);

    const now = Date.now();
    const retained: CleanupEntry[] = [];
    cleanupQueueRef.current.forEach((entry) => {
      const bundle = entry.bundle;
      const withinGrace = now - entry.enqueuedAt < BUNDLE_REVOKE_GRACE_MS;
      if (keep.has(bundle.htmlUrl) || (!force && withinGrace)) {
        retained.push(entry);
        return;
      }
      bundle.urls.forEach((url) => {
        try { URL.revokeObjectURL(url); } catch {}
      });
    });
    cleanupQueueRef.current = retained;
  };

  useEffect(() => {
    return () => {
      if (rebuildTimerRef.current) {
        window.clearTimeout(rebuildTimerRef.current);
      }
      const allBundles: UrlBundle[] = [];
      if (activeBundleRef.current) allBundles.push(activeBundleRef.current);
      if (stagedBundleRef.current && !allBundles.some(b => b.htmlUrl === stagedBundleRef.current?.htmlUrl)) {
        allBundles.push(stagedBundleRef.current);
      }
      if (lastGoodBundleRef.current && !allBundles.some(b => b.htmlUrl === lastGoodBundleRef.current?.htmlUrl)) {
        allBundles.push(lastGoodBundleRef.current);
      }
      allBundles.push(...cleanupQueueRef.current.map(entry => entry.bundle));
      const seen = new Set<string>();
      allBundles.forEach((bundle) => {
        bundle.urls.forEach((url) => {
          if (seen.has(url)) return;
          seen.add(url);
          try { URL.revokeObjectURL(url); } catch {}
        });
      });
      vendorUrlsRef.current.forEach((url) => {
        try { URL.revokeObjectURL(url); } catch {}
      });
    };
  }, []);

  useEffect(() => {
    const loadVendors = async () => {
      try {
        const fetchText = async (fn: string) => {
          const r = await fetch(`vendor/${fn}`);
          if (!r.ok) throw new Error(`Asset ${fn} missing`);
          return await r.text();
        };
        const [rCode, rdCode] = await Promise.all([fetchText('react.js'), fetchText('react-dom.js')]);
        
        const wrap = (c: string) => `(function() { ${c} }).call(window);`;
        const create = (c: string) => URL.createObjectURL(new Blob([c], { type: 'text/javascript' }));
        
        const reactUrl = create(`const global=window; ${wrap(rCode)} export default global.React; export const { useState, useEffect, useRef, useMemo, useCallback, useContext, useReducer, useLayoutEffect, useImperativeHandle, Fragment, StrictMode, Suspense, lazy, memo, forwardRef, Children, cloneElement, createElement, isValidElement } = global.React;`);
        const reactDomUrl = create(`import React from 'react'; ${wrap(rdCode)} export default window.ReactDOM;`);
        const reactDomClientUrl = create(`import rd from 'react-dom'; export const createRoot = rd.createRoot; export default { createRoot };`);
        const urls = [reactUrl, reactDomUrl, reactDomClientUrl];
        const imports: Record<string, string> = {
          'react': reactUrl,
          'react-dom': reactDomUrl,
          'react-dom/client': reactDomClientUrl
        };

        try {
          const threeCode = await fetchText('three.module.js');
          const threeUrl = create(threeCode);
          urls.push(threeUrl);
          imports['three'] = threeUrl;
        } catch {
          const warning: ConsoleLog = {
            type: 'warn',
            content: 'Preview warning: vendor/three.module.js missing. three.js imports will fail until assets are prepared.',
            timestamp: new Date().toLocaleTimeString()
          };
          setLogs(prev => [...prev.slice(-100), warning]);
        }

        vendorUrlsRef.current = urls;
        setVendorMap(imports);
      } catch (e) { 
        console.error("Vendor load failed", e); 
        const msg = 'Critical: System assets failed to load.';
        setPreviewBanner({ severity: 'error', stage: 'compile', message: msg, details: [msg] });
        onPreviewStatusRef.current?.({ candidateOk: false, usedLastGood: false, errors: [msg], stage: 'compile' });
      }
    };
    loadVendors();
  }, []);

  useEffect(() => {
    if (isLoading) return;
    const compile = async () => {
      if (window.electronAPI?.compileTailwind) {
        const result = await window.electronAPI.compileTailwind({
          files: files,
          configCode: files['tailwind.config.js'] || '',
          cssInput: files['input.css'] || ''
        });
        if (result.css) setCompiledCss(result.css);
        if (result.warning) {
          setLogs(prev => [...prev.slice(-100), {
            type: 'warn',
            content: `Tailwind compile warning: ${result.warning}`,
            timestamp: new Date().toLocaleTimeString()
          }]);
        }
      }
    };
    compile();
  }, [files, isLoading]);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.data && event.data.source === 'localship-preview') {
        if (event.data.type === 'test-report') {
          let report: any = { ok: false, errors: ['Invalid test-report payload'] };
          try {
            report = JSON.parse(event.data.content);
          } catch {
            // keep fallback report
          }
          const runId = Number(event.data.runId || 0);
          if (runId === currentRunIdRef.current) {
            const errors = Array.isArray(report?.errors) ? report.errors.map(String) : [];
            const stagedBundle = stagedBundleRef.current && stagedBundleRef.current.id === runId
              ? stagedBundleRef.current
              : null;
            if (report?.ok && currentRunErrorsRef.current.length === 0) {
              const previousActive = activeBundleRef.current;
              if (stagedBundle) {
                activeBundleRef.current = stagedBundle;
                lastGoodBundleRef.current = stagedBundle;
                setPreviewUrl(stagedBundle.htmlUrl);
                setPendingPreviewUrl(null);
                stagedBundleRef.current = null;
                if (previousActive && previousActive.htmlUrl !== stagedBundle.htmlUrl) {
                  enqueueBundleForCleanup(previousActive);
                }
              } else if (activeBundleRef.current) {
                lastGoodBundleRef.current = activeBundleRef.current;
              }
              if (
                pendingPreviousBundleRef.current &&
                (!activeBundleRef.current || pendingPreviousBundleRef.current.htmlUrl !== activeBundleRef.current.htmlUrl)
              ) {
                enqueueBundleForCleanup(pendingPreviousBundleRef.current);
              }
              pendingPreviousBundleRef.current = null;
              flushStaleBundles();
              onPreviewStatusRef.current?.({
                candidateOk: true,
                usedLastGood: false,
                errors: [],
                stage: 'smoke',
                warnings: currentPreflightWarningsRef.current,
                autoHealed: currentAutoHealedRef.current
              });
            } else {
              const mergedErrors = Array.from(new Set([...currentRunErrorsRef.current, ...errors]));
              if (stagedBundle) {
                enqueueBundleForCleanup(stagedBundle);
                stagedBundleRef.current = null;
                setPendingPreviewUrl(null);
              }
              const fallbackBundle = lastGoodBundleRef.current || activeBundleRef.current;
              if (lastGoodFallbackEnabled && fallbackBundle) {
                if (activeBundleRef.current && activeBundleRef.current.htmlUrl !== fallbackBundle.htmlUrl) {
                  enqueueBundleForCleanup(activeBundleRef.current);
                }
                if (pendingPreviousBundleRef.current && pendingPreviousBundleRef.current.htmlUrl !== fallbackBundle.htmlUrl) {
                  enqueueBundleForCleanup(pendingPreviousBundleRef.current);
                }
                activeBundleRef.current = fallbackBundle;
                setPreviewUrl(fallbackBundle.htmlUrl);
                pendingPreviousBundleRef.current = null;
                flushStaleBundles();
                onPreviewStatusRef.current?.({
                  candidateOk: false,
                  usedLastGood: true,
                  errors: mergedErrors,
                  stage: 'smoke',
                  warnings: currentPreflightWarningsRef.current,
                  autoHealed: currentAutoHealedRef.current
                });
              } else {
                pendingPreviousBundleRef.current = null;
                onPreviewStatusRef.current?.({
                  candidateOk: false,
                  usedLastGood: false,
                  errors: mergedErrors,
                  stage: 'smoke',
                  warnings: currentPreflightWarningsRef.current,
                  autoHealed: currentAutoHealedRef.current
                });
              }
            }
          }
          onTestReportRef.current?.(report);
          return;
        }
        const newLog: ConsoleLog = {
          type: event.data.type,
          content: event.data.content,
          timestamp: new Date().toLocaleTimeString()
        };
        setLogs(prev => [...prev.slice(-100), newLog]);
        if (newLog.type === 'error') {
          setIsConsoleExpanded(true);
          const runId = Number(event.data.runId || 0);
          if (runId === currentRunIdRef.current) {
            currentRunErrorsRef.current = Array.from(new Set([...currentRunErrorsRef.current, newLog.content]));
            const fatal = /mount failure|runtime fault|initialization crashed|babel error/i.test(newLog.content);
            if (fatal) {
              const stagedBundle = stagedBundleRef.current && stagedBundleRef.current.id === runId
                ? stagedBundleRef.current
                : null;
              if (stagedBundle) {
                enqueueBundleForCleanup(stagedBundle);
                stagedBundleRef.current = null;
                setPendingPreviewUrl(null);
              }
              const fallbackBundle = lastGoodBundleRef.current || activeBundleRef.current;
              if (lastGoodFallbackEnabled && fallbackBundle) {
                if (activeBundleRef.current && activeBundleRef.current.htmlUrl !== fallbackBundle.htmlUrl) {
                  enqueueBundleForCleanup(activeBundleRef.current);
                }
                if (pendingPreviousBundleRef.current && pendingPreviousBundleRef.current.htmlUrl !== fallbackBundle.htmlUrl) {
                  enqueueBundleForCleanup(pendingPreviousBundleRef.current);
                }
                activeBundleRef.current = fallbackBundle;
                setPreviewUrl(fallbackBundle.htmlUrl);
                pendingPreviousBundleRef.current = null;
                flushStaleBundles();
                onPreviewStatusRef.current?.({
                  candidateOk: false,
                  usedLastGood: true,
                  errors: currentRunErrorsRef.current,
                  stage: 'mount',
                  warnings: currentPreflightWarningsRef.current,
                  autoHealed: currentAutoHealedRef.current
                });
              } else {
                pendingPreviousBundleRef.current = null;
                onPreviewStatusRef.current?.({
                  candidateOk: false,
                  usedLastGood: false,
                  errors: currentRunErrorsRef.current,
                  stage: 'mount',
                  warnings: currentPreflightWarningsRef.current,
                  autoHealed: currentAutoHealedRef.current
                });
              }
            }
          }
        }
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [lastGoodFallbackEnabled]);

  useEffect(() => {
    if (isLoading || !vendorMap) return;
    
    const updatePreview = async () => {
      setPreviewBanner(null);
      setShowBannerDetails(false);
      const preflight = runPreviewPreflight(files);
      currentPreflightWarningsRef.current = preflight.warnings;
      currentAutoHealedRef.current = preflight.autoHealed;
      if (!preflight.ok || !preflight.entryFile) {
        const fatalErrors = preflight.fatalErrors.length > 0 ? preflight.fatalErrors : ['Missing preview entry file.'];
        const msg = `Preview preflight failed: ${fatalErrors[0] || 'Unknown error'}`;
        currentRunErrorsRef.current = Array.from(new Set([...currentRunErrorsRef.current, ...fatalErrors]));
        setPreviewBanner({
          severity: 'error',
          stage: 'preflight',
          message: msg,
          details: fatalErrors
        });
        const fallbackBundle = lastGoodBundleRef.current || activeBundleRef.current;
        if (lastGoodFallbackEnabled && fallbackBundle) {
          activeBundleRef.current = fallbackBundle;
          setPreviewUrl(fallbackBundle.htmlUrl);
          setPendingPreviewUrl(null);
          onPreviewStatusRef.current?.({
            candidateOk: false,
            usedLastGood: true,
            errors: fatalErrors,
            stage: 'preflight',
            warnings: preflight.warnings,
            autoHealed: preflight.autoHealed
          });
        } else {
          onPreviewStatusRef.current?.({
            candidateOk: false,
            usedLastGood: false,
            errors: fatalErrors,
            stage: 'preflight',
            warnings: preflight.warnings,
            autoHealed: preflight.autoHealed
          });
        }
        return;
      }

      if (preflight.warnings.length > 0) {
        setPreviewBanner({
          severity: 'warning',
          stage: 'preflight',
          message: `Preview auto-healed: ${preflight.warnings[0]}`,
          details: preflight.warnings
        });
      }

      const importMap = { imports: { ...vendorMap } };
      const runUrls: string[] = [];
      const cssStubUrl = URL.createObjectURL(new Blob(['export default {};'], { type: 'text/javascript' }));
      runUrls.push(cssStubUrl);

      const sourceBundle = Object.entries(files)
        .filter(([name]) => name.match(/\.(tsx|ts|jsx|js)$/))
        .map(([, raw]) => String(raw || ''))
        .join('\n');
      const needsThree = /from\s+['"]three['"]|import\(\s*['"]three['"]\s*\)/.test(sourceBundle);
      const usesThreeExamples = /from\s+['"]three\/examples\/jsm\//.test(sourceBundle);

      if (usesThreeExamples) {
        const msg = "Preview limitation: `three/examples/jsm/*` is not supported. Use core `import * as THREE from 'three'`.";
        currentRunErrorsRef.current = Array.from(new Set([...currentRunErrorsRef.current, msg]));
        setPreviewBanner({ severity: 'error', stage: 'compile', message: msg, details: [msg] });
        const fallbackBundle = lastGoodBundleRef.current || activeBundleRef.current;
        if (lastGoodFallbackEnabled && fallbackBundle) {
          activeBundleRef.current = fallbackBundle;
          setPreviewUrl(fallbackBundle.htmlUrl);
          setPendingPreviewUrl(null);
          onPreviewStatusRef.current?.({ candidateOk: false, usedLastGood: true, errors: [msg], stage: 'compile' });
        } else {
          onPreviewStatusRef.current?.({ candidateOk: false, usedLastGood: false, errors: [msg], stage: 'compile' });
        }
        return;
      }

      if (needsThree && !importMap.imports['three']) {
        const msg = "Missing local three.js vendor mapping (`public/vendor/three.module.js`). Run asset prep to enable preview.";
        const errorLog: ConsoleLog = {
          type: 'error',
          content: msg,
          timestamp: new Date().toLocaleTimeString()
        };
        setLogs(prev => [...prev.slice(-100), errorLog]);
        currentRunErrorsRef.current = Array.from(new Set([...currentRunErrorsRef.current, msg]));

        const fallbackBundle = lastGoodBundleRef.current || activeBundleRef.current;
        if (lastGoodFallbackEnabled && fallbackBundle) {
          if (activeBundleRef.current && activeBundleRef.current.htmlUrl !== fallbackBundle.htmlUrl) {
            enqueueBundleForCleanup(activeBundleRef.current);
          }
          if (pendingPreviousBundleRef.current && pendingPreviousBundleRef.current.htmlUrl !== fallbackBundle.htmlUrl) {
            enqueueBundleForCleanup(pendingPreviousBundleRef.current);
          }
          activeBundleRef.current = fallbackBundle;
          setPreviewUrl(fallbackBundle.htmlUrl);
          pendingPreviousBundleRef.current = null;
          flushStaleBundles();
          setPreviewBanner({ severity: 'warning', stage: 'compile', message: msg, details: [msg] });
          onPreviewStatusRef.current?.({ candidateOk: false, usedLastGood: true, errors: [msg], stage: 'compile' });
        } else {
          setPreviewBanner({ severity: 'error', stage: 'compile', message: msg, details: [msg] });
          onPreviewStatusRef.current?.({ candidateOk: false, usedLastGood: false, errors: [msg], stage: 'compile' });
        }
        return;
      }

      Object.keys(files).forEach((name) => {
        if (!name.endsWith('.css')) return;
        const normalized = name.replace(/\\/g, '/').replace(/^\.?\//, '');
        importMap.imports[`local-project/${normalized}`] = cssStubUrl;
        importMap.imports[`local-project/${normalized.replace(/\.css$/i, '')}`] = cssStubUrl;
      });
      importMap.imports['local-project/input.css'] = cssStubUrl;
      
      // Improved path resolver for nested projects
      const resolveRelative = (fromFile: string, toPath: string) => {
        const parts = fromFile.split('/');
        parts.pop(); // remove filename
        toPath.split('/').forEach(p => {
            if (!p || p === '.') return;
            if (p === '..') parts.pop();
            else parts.push(p);
        });
        return parts.join('/').replace(/\.(tsx|ts|js|jsx)$/, '');
      };
      
      Object.entries(files).forEach(([name, raw]) => {
        if (name.match(/\.(tsx|ts|js)$/)) {
          try {
            const transformed = Babel.transform(raw as string, {
              presets: [['react', { runtime: 'classic' }], 'typescript'],
              plugins: [() => ({
                visitor: {
                  ImportDeclaration(path: any) {
                    const source = path.node.source.value as string;
                    // CSS is injected separately via compiled Tailwind output.
                    // Removing CSS imports avoids invalid `local-project/*.css` module specifiers.
                    if (source.endsWith('.css')) {
                      path.remove();
                      return;
                    }
                    if (source.startsWith('.')) {
                      const resolved = resolveRelative(name, source);
                      path.node.source.value = `local-project/${resolved}`;
                    }
                  }
                }
              })],
              filename: name,
              retainLines: true
            }).code;
            
            const url = URL.createObjectURL(new Blob([transformed || ''], { type: 'text/javascript' }));
            runUrls.push(url);
            const cleanName = name.replace(/\.(tsx|ts|js)$/, '');
            importMap.imports[`local-project/${cleanName}`] = url;
            importMap.imports[`local-project/${name}`] = url;
            const noIndex = cleanName.replace(/\/index$/, '');
            if (noIndex !== cleanName) {
              importMap.imports[`local-project/${noIndex}`] = url;
            }
          } catch (e: any) {
            const msg = `Babel Error in ${name}: ${e.message}`;
            currentRunErrorsRef.current = Array.from(new Set([...currentRunErrorsRef.current, msg]));
            setPreviewBanner({ severity: 'error', stage: 'compile', message: msg, details: [msg] });
          }
        }
      });

      const runId = currentRunIdRef.current + 1;
      currentRunIdRef.current = runId;
      currentRunErrorsRef.current = [];

      const harnessScript = `
        <script>
          (function() {
            const __RUN_ID__ = ${runId};
            const safeSend = (type, args) => {
               try {
                 const content = Array.from(args).map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
                 window.parent.postMessage({ source: 'localship-preview', runId: __RUN_ID__, type, content }, '*');
               } catch(e) {}
            };
            
            const _orig = { log: console.log, error: console.error, warn: console.warn };
            let _hadRuntimeError = false;

            window.onerror = (msg, url, line) => { 
                _hadRuntimeError = true;
                safeSend('error', ["Runtime Fault: " + msg + " at line " + line]); 
                return false; 
            };

            console.log = (...args) => { safeSend('log', args); _orig.log.apply(console, args); };
            console.error = (...args) => { safeSend('error', args); _orig.error.apply(console, args); };
            console.warn = (...args) => { safeSend('warn', args); _orig.warn.apply(console, args); };

            // Smoke Test Runner
            window.addEventListener('load', async () => {
              await new Promise(r => setTimeout(r, 1200));
              const report = { ok: true, errors: [], clicks: [], metadata: { initialTerminal: false, hadRuntimeError: _hadRuntimeError } };
              
              const initialText = document.body.innerText.toLowerCase();
              if (initialText.includes('game over') || initialText.includes('failed') || initialText.includes('critical error')) {
                report.metadata.initialTerminal = true;
              }

              const interactives = Array.from(document.querySelectorAll('button, [role="button"], [data-action]'));
              
              for (const el of interactives.slice(0, 5)) {
                const beforeText = document.body.innerText;
                const label = el.innerText || el.getAttribute('data-action') || 'action';
                el.click();
                await new Promise(r => setTimeout(r, 200));
                const afterText = document.body.innerText;
                report.clicks.push({ label, changed: beforeText !== afterText });
              }

              if (report.metadata.hadRuntimeError) {
                  report.ok = false;
                  report.errors.push("Initialization crashed.");
              }

              if (report.metadata.initialTerminal && report.clicks.every(c => !c.changed)) {
                report.ok = false;
                report.errors.push("App stuck in terminal state.");
              }

              if (window.__LOCALSHIP_SELFTEST__) {
                 try {
                   const res = await window.__LOCALSHIP_SELFTEST__();
                   if (!res.ok) { report.ok = false; report.errors.push(...(res.report || [])); }
                 } catch(e) { report.errors.push("Selftest hook crashed: " + e.message); }
              }

              safeSend('test-report', [JSON.stringify(report)]);
            });
          })();
        </script>
      `;

      const entryAlias = preflight.entryFile
        ? `local-project/${preflight.entryFile.replace(/\.(tsx|ts|jsx|js)$/i, '')}`
        : 'local-project/index';
      let html = preflight.syntheticIndexHtml || files['index.html'] || FALLBACK_HTML;
      // Prevent raw module scripts from user HTML from bypassing our transformed import map pipeline.
      html = html.replace(/<script[^>]*type=["']module["'][^>]*src=["'][^"']+["'][^>]*>\s*<\/script>/gi, '');
      html = html.replace(/<script[^>]*type=["']importmap["'][^>]*>[\s\S]*?<\/script>/gi, '');
      html = html.replace(/<link[^>]+href=["'][^"']*input\.css[^"']*["'][^>]*>/gi, '');
      const injected = `
        ${harnessScript}
        <style id="__tailwind_injected">body { margin: 0; padding: 0; font-family: sans-serif; } ${compiledCss}</style>
        <script type="importmap">${JSON.stringify(importMap)}</script>
        <script type="module">
          import React from 'react';
          import ReactDOM from 'react-dom/client';
          import('${entryAlias}').catch(e => console.error("Mount Failure: " + e.message));
        </script>
      `;

      if (html.includes('</head>')) {
        html = html.replace('</head>', `${injected}</head>`);
      } else {
        html = `<head>${injected}</head>${html}`;
      }
      const candidateUrl = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
      runUrls.push(candidateUrl);
      if (stagedBundleRef.current && stagedBundleRef.current.htmlUrl !== candidateUrl) {
        enqueueBundleForCleanup(stagedBundleRef.current);
      }
      pendingPreviousBundleRef.current = activeBundleRef.current;
      stagedBundleRef.current = { id: runId, htmlUrl: candidateUrl, urls: runUrls };
      setPendingPreviewUrl(candidateUrl);
      onPreviewStatusRef.current?.({
        candidateOk: false,
        usedLastGood: false,
        errors: [],
        stage: 'preflight',
        warnings: preflight.warnings,
        autoHealed: preflight.autoHealed
      });
    };

    if (rebuildTimerRef.current) {
      window.clearTimeout(rebuildTimerRef.current);
    }
    rebuildTimerRef.current = window.setTimeout(() => {
      updatePreview();
    }, 120);

    return () => {
      if (rebuildTimerRef.current) {
        window.clearTimeout(rebuildTimerRef.current);
      }
    };
  }, [files, isLoading, vendorMap, compiledCss]);

  return (
    <div className="w-full h-full bg-white flex flex-col relative overflow-hidden select-none">
      {previewBanner && (
        <div className={`shrink-0 border-b px-3 py-2 ${previewBanner.severity === 'error' ? 'bg-rose-50 border-rose-200 text-rose-700 dark:bg-rose-950/40 dark:border-rose-900/60 dark:text-rose-200' : 'bg-amber-50 border-amber-200 text-amber-700 dark:bg-amber-950/30 dark:border-amber-900/50 dark:text-amber-200'}`}>
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className={`text-[9px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded ${previewBanner.severity === 'error' ? 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-200' : 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-200'}`}>
                  {previewBanner.severity}
                </span>
                <span className="text-[10px] uppercase tracking-widest opacity-75">{previewBanner.stage}</span>
              </div>
              <p className="text-xs font-medium truncate mt-1">{previewBanner.message}</p>
            </div>
            {previewBanner.details.length > 1 && (
              <button
                onClick={() => setShowBannerDetails(prev => !prev)}
                className="text-[10px] font-bold uppercase tracking-widest hover:opacity-80"
              >
                {showBannerDetails ? 'Hide Details' : 'Details'}
              </button>
            )}
          </div>
          {showBannerDetails && previewBanner.details.length > 1 && (
            <pre className="mt-2 text-[10px] whitespace-pre-wrap font-mono opacity-90">{previewBanner.details.join('\n')}</pre>
          )}
        </div>
      )}

      <div className="flex-1 relative bg-slate-50 dark:bg-slate-900 overflow-hidden">
        {previewUrl && (
          <iframe
            src={previewUrl}
            onLoad={() => flushStaleBundles(false)}
            className="w-full h-full block border-none shadow-inner"
            sandbox="allow-scripts allow-popups allow-modals allow-same-origin allow-forms"
          />
        )}
        {pendingPreviewUrl && (
          <iframe
            src={pendingPreviewUrl}
            className="hidden"
            sandbox="allow-scripts allow-popups allow-modals allow-same-origin allow-forms"
          />
        )}
      </div>

      {devMode && (
        <div className="flex-shrink-0 flex flex-col border-t border-slate-200 dark:border-ocean-800 bg-white dark:bg-ocean-950">
          <div onClick={() => setIsConsoleExpanded(!isConsoleExpanded)} className="h-10 px-4 bg-slate-50 dark:bg-ocean-900 flex justify-between items-center cursor-pointer hover:bg-slate-100 dark:hover:bg-ocean-800 transition-colors">
             <div className="flex items-center gap-3">
                <svg className={`w-3 h-3 text-slate-400 transition-transform ${isConsoleExpanded ? '' : '-rotate-90'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M19 9l-7 7-7-7" /></svg>
                <span className="text-[10px] font-black uppercase tracking-widest text-slate-500">Console Output</span>
             </div>
          </div>
          <div className={`transition-all duration-300 overflow-hidden bg-white dark:bg-black/20 ${isConsoleExpanded ? 'h-48' : 'h-0'}`}>
            <div className="h-full overflow-y-auto p-4 font-mono text-[10px] space-y-1 select-text">
              {logs.map((log, i) => (
                <div key={i} className={`flex gap-3 ${log.type === 'error' ? 'text-red-500 font-bold' : 'text-slate-400'}`}>
                  <span className="opacity-30">[{log.timestamp}]</span>
                  <span className="break-all">{log.content}</span>
                </div>
              ))}
              <div ref={consoleEndRef} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default PreviewFrame;
