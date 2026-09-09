import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

interface StyleDeclaration {
  file: string;
  line: number;
  property: string;
  value: string;
}

const pageStyleDirectory = join(process.cwd(), 'src/director/styles/pages');

function pageStyles(): { file: string; css: string }[] {
  return readdirSync(pageStyleDirectory)
    .filter((file) => file.endsWith('.css'))
    .sort()
    .map((file) => ({ file, css: readFileSync(join(pageStyleDirectory, file), 'utf8') }));
}

function declarations(file: string, css: string): StyleDeclaration[] {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, (comment) =>
    '\n'.repeat(comment.split('\n').length - 1),
  );
  return [...withoutComments.matchAll(/([\w-]+)\s*:\s*([^;{}]+);/g)].map((match) => ({
    file,
    line: withoutComments.slice(0, match.index ?? 0).split('\n').length,
    property: match[1] ?? '',
    value: (match[2] ?? '').trim(),
  }));
}

function location(declaration: StyleDeclaration): string {
  return `${declaration.file}:${declaration.line} ${declaration.property}: ${declaration.value}`;
}

describe('Director page stylesheet contract', () => {
  const allDeclarations = pageStyles().flatMap(({ file, css }) => declarations(file, css));

  test('page styles get palette and elevation values from Director tokens', () => {
    const visualProperty =
      /^(?:color|background(?:-color)?|border(?:-(?:top|right|bottom|left))?(?:-color)?|outline|box-shadow|fill|stroke)$/;
    const literalColour = /(?:#[0-9a-f]{3,8}\b|\b(?:rgb|hsl)a?\(|\b(?:white|black)\b)/i;
    const violations = allDeclarations
      .filter(({ property, value }) => visualProperty.test(property) && literalColour.test(value))
      .map(location);

    expect(violations).toEqual([]);
  });

  test('page styles use the shared Director type scale', () => {
    const violations = allDeclarations
      .filter(({ property, value }) => property === 'font-size' && !value.includes('var(--director-text-'))
      .map(location);

    expect(violations).toEqual([]);
  });

  test('page motion uses Director duration tokens', () => {
    const motionProperty = /^(?:animation|animation-duration|transition|transition-duration)$/;
    const literalDuration = /(?:^|\s|,)\d*\.?\d+(?:ms|s)\b/i;
    const violations = allDeclarations
      .filter(({ property, value }) => motionProperty.test(property) && literalDuration.test(value))
      .map(location);

    expect(violations).toEqual([]);
  });

  test('page styles do not shrink the shared icon-button target', () => {
    const violations = pageStyles().flatMap(({ file, css }) => {
      const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
      return [...withoutComments.matchAll(/([^{}]*\.director-icon-button[^{}]*)\{([^}]*)\}/g)]
        .filter((match) => /\b(?:width|height|font-size)\s*:/.test(match[2] ?? ''))
        .map((match) => `${file}: ${(match[1] ?? '.director-icon-button').trim()}`);
    });

    expect(violations).toEqual([]);
  });
});
