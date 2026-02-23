import { ProjectFiles } from '../types';
import * as Babel from '@babel/standalone';
import { isAssetFilename, isEncodedAssetContent, toAssetContextPlaceholder } from './assetUtils';

export const resolvePath = (baseFile: string, targetPath: string): string => {
  if (!targetPath.startsWith('.')) return targetPath;
  const parts = baseFile.split('/');
  parts.pop();
  const targetParts = targetPath.split('/');
  for (const part of targetParts) {
    if (part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
};

const resolveImportToExistingFile = (files: ProjectFiles, baseFile: string, spec: string): string | null => {
  const direct = resolvePath(baseFile, spec);
  if (files[direct]) return direct;

  const extensions = ['.tsx', '.ts', '.jsx', '.js', '.json', '.css', '.html'];
  for (const ext of extensions) {
    if (files[`${direct}${ext}`]) return `${direct}${ext}`;
  }

  for (const ext of extensions) {
    if (files[`${direct}/index${ext}`]) return `${direct}/index${ext}`;
  }

  return null;
};

export const getFileStructureSummary = (files: ProjectFiles): string => {
  return Object.keys(files).sort().map(f => `- ${f}`).join('\n');
};

export const getFileContentsContext = (files: ProjectFiles): string => {
  return Object.entries(files)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, content]) => {
      const raw = String(content || '');
      const text = (isAssetFilename(name) || isEncodedAssetContent(raw))
        ? toAssetContextPlaceholder(name, raw)
        : raw;
      return `<!-- filename: ${name} -->\n${text}`;
    })
    .join('\n\n');
};

export const processHtmlForOffline = (htmlContent: string): string => {
  let processed = htmlContent;
  processed = processed.replace(/<script\s+[^>]*src=["']https:\/\/cdn\.tailwindcss\.com[^"']*["'][^>]*><\/script>/gi, '');
  processed = processed.replace(/<link\s+[^>]*href=["']https:\/\/.*tailwindcss.*["'][^>]*>/gi, '');
  return processed;
};

/**
 * WIRING VALIDATOR (Strict Enforcement)
 */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export interface PreviewPreflightResult {
  ok: boolean;
  fatalErrors: string[];
  warnings: string[];
  entryFile: string | null;
  syntheticIndexHtml: string | null;
  autoHealed: string[];
}

export const validateProject = (files: ProjectFiles): ValidationResult => {
  const errors: string[] = [];

  // 1. Mandatory Files Exist
  const mandatory = ['index.html', 'index.tsx', 'App.tsx', 'input.css', 'tailwind.config.js'];
  mandatory.forEach(f => {
    if (!files[f]) errors.push(`Missing mandatory file: ${f}`);
  });

  // 2. Entry-Chain Check
  if (files['index.html'] && !files['index.html'].includes('id="root"')) {
    errors.push('index.html must contain a <div id="root"> element.');
  }
  if (files['index.tsx'] && !files['index.tsx'].includes('ReactDOM.createRoot')) {
    errors.push('index.tsx must use ReactDOM.createRoot for React 18+ syntax.');
  }

  // 3. Tailwind Wiring
  if (files['input.css']) {
    const hasBase = files['input.css'].includes('@tailwind base;');
    const hasComp = files['input.css'].includes('@tailwind components;');
    const hasUtil = files['input.css'].includes('@tailwind utilities;');
    if (!hasBase || !hasComp || !hasUtil) {
      errors.push('input.css must contain all three @tailwind directives (base, components, utilities).');
    }
  }

  // 4. App Export Validation (Crucial for preview)
  const appContent = files['App.tsx'] || '';
  if (appContent && !/export\s+default\s+/m.test(appContent)) {
    errors.push('App.tsx must contain a default export (e.g., export default App;).');
  }
  if (appContent && /```/.test(appContent)) {
    errors.push('App.tsx contains markdown code fences. Return plain TSX source only.');
  }
  if (appContent && !/(const|function|class)\s+App\b/m.test(appContent)) {
    errors.push('App.tsx should define an App component before exporting it.');
  }

  // 5. Deterministische UI Visibility & Guardrails
  Object.entries(files).forEach(([name, content]) => {
    const text = String(content || '');
    if (isAssetFilename(name) || isEncodedAssetContent(text)) return;
    const isCodeModule = /\.(tsx?|jsx?)$/i.test(name);

    // 5a. Import Target Exists (relative only; allow extensionless specifiers)
    if (isCodeModule) {
      const specRegex = /import\s+[\s\S]*?from\s+['"]([^'"]+)['"]/g;
      let specMatch;
      while ((specMatch = specRegex.exec(text)) !== null) {
        const spec = specMatch[1];
        if (spec.startsWith('local-project/')) {
          errors.push(`${name}: Invalid import "${spec}". Use relative imports like ./Component.tsx.`);
          continue;
        }
        if (spec.startsWith('./') || spec.startsWith('../')) {
          const resolved = resolveImportToExistingFile(files, name, spec);
          if (!resolved) {
            errors.push(`${name}: Import not found: ${spec}.`);
          }
        }
      }

      // 5a-2. Relative default imports require a default export in target module.
      const defaultImportRegex = /import\s+([A-Za-z_$][\w$]*)\s*(?:,\s*{[^}]*})?\s+from\s+['"]([^'"]+)['"]/g;
      let defaultMatch;
      while ((defaultMatch = defaultImportRegex.exec(text)) !== null) {
        const importedName = defaultMatch[1];
        const spec = defaultMatch[2];
        if (!(spec.startsWith('./') || spec.startsWith('../'))) continue;
        const resolved = resolveImportToExistingFile(files, name, spec);
        if (!resolved) continue;
        const targetContent = files[resolved] || '';
        if (!/\.(tsx?|jsx?)$/i.test(resolved)) continue;

        const hasDefaultExport =
          /export\s+default\s+/m.test(targetContent) ||
          /export\s*{\s*default\s*(?:as\s+[A-Za-z_$][\w$]*)?\s*}/m.test(targetContent);

        if (!hasDefaultExport) {
          errors.push(`${name}: Default import "${spec}" (${importedName}) requires a default export in ${resolved}.`);
        }
      }
    }

    // 5b. Grid Sizing
    if (name.endsWith('.tsx') && (text.includes('grid-cols-') || text.includes('gridTemplateColumns'))) {
      const hasRows = text.includes('grid-rows-') || text.includes('auto-rows-') || text.includes('gridTemplateRows');
      const hasAspect = text.includes('aspect-square');
      const hasHeight = text.includes('h-') || text.includes('height:') || text.includes('h[');
      
      if (!hasRows && !hasAspect && !hasHeight) {
        errors.push(`${name}: Grid layout detected without explicit rows, aspect-square, or height. Container might be zero-height.`);
      }
    }
    
    // 5c. Forbidden Types
    if (isCodeModule && text.includes('NodeJS.Timeout')) {
      errors.push(`${name}: Forbidden 'NodeJS.Timeout' used. Use 'ReturnType<typeof setTimeout>' instead.`);
    }

    // 5d. JSX Component Usage Without Definition/Import (best-effort)
    if (name.endsWith('.tsx')) {
      const tagMatches = Array.from(text.matchAll(/<([A-Z][A-Za-z0-9_]*)\b/g)).map(m => m[1]);
      const uniqueTags = Array.from(new Set(tagMatches));
      uniqueTags.forEach((tag) => {
        const hasImport = new RegExp(`import\\s+[\\s\\S]*?\\b${tag}\\b`, 'm').test(text);
        const hasDecl = new RegExp(`(const|function|class)\\s+${tag}\\b`, 'm').test(text);
        if (!hasImport && !hasDecl) {
          errors.push(`${name}: JSX tag <${tag}> used but "${tag}" is not imported or defined.`);
        }
      });
    }

    // 5e. Syntax Validation for JS/TS files
    if (isCodeModule) {
      try {
        Babel.transform(text, {
          presets: [['react', { runtime: 'classic' }], 'typescript'],
          filename: name,
          sourceType: 'module'
        });
      } catch (e: any) {
        errors.push(`${name}: Syntax error: ${e?.message || 'Unable to parse file.'}`);
      }
    }
  });

  return {
    valid: errors.length === 0,
    errors
  };
};

export const runPreviewPreflight = (files: ProjectFiles): PreviewPreflightResult => {
  const fatalErrors: string[] = [];
  const warnings: string[] = [];
  const autoHealed: string[] = [];
  const entryCandidates = [
    'index.tsx', 'index.jsx', 'main.tsx', 'main.jsx',
    'src/index.tsx', 'src/index.jsx', 'src/main.tsx', 'src/main.jsx'
  ];

  const entryFile = entryCandidates.find((name) => {
    const content = files[name];
    return typeof content === 'string' && content.trim().length > 0;
  }) || null;

  if (!entryFile) {
    fatalErrors.push('No JS/TS entry file found (expected index/main in root or src).');
  }

  let syntheticIndexHtml: string | null = null;
  const existingHtml = files['index.html'];
  const appTitle = 'LocalShip Preview';

  if (!existingHtml) {
    syntheticIndexHtml = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${appTitle}</title>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>`;
    warnings.push('missing_index_html_auto_healed');
    autoHealed.push('index.html');
  } else if (!/id=["']root["']/.test(existingHtml)) {
    syntheticIndexHtml = existingHtml.includes('<body')
      ? existingHtml.replace(/<body[^>]*>/i, (m) => `${m}\n<div id="root"></div>`)
      : `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${appTitle}</title></head><body><div id="root"></div>${existingHtml}</body></html>`;
    warnings.push('missing_root_mount_auto_healed');
    autoHealed.push('index.html#root');
  }

  if (entryFile) {
    const entryContent = files[entryFile] || '';
    const appImport = /import\s+([A-Za-z_$][\w$]*)\s+from\s+['"]([^'"]+)['"]/.exec(entryContent);
    if (appImport) {
      const spec = appImport[2];
      if (spec.startsWith('./') || spec.startsWith('../')) {
        const resolved = resolveImportToExistingFile(files, entryFile, spec);
        if (!resolved) {
          warnings.push(`${entryFile}: import target not found: ${spec}`);
        } else {
          const content = files[resolved] || '';
          if (!/export\s+default\s+/m.test(content)) {
            warnings.push(`${resolved}: imported as default but no default export detected.`);
          }
        }
      }
    } else {
      warnings.push(`${entryFile}: no default app import detected; preview may still mount.`);
    }
  }

  return {
    ok: fatalErrors.length === 0,
    fatalErrors: Array.from(new Set(fatalErrors)),
    warnings: Array.from(new Set(warnings)),
    entryFile,
    syntheticIndexHtml,
    autoHealed: Array.from(new Set(autoHealed))
  };
};
