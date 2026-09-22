'use client'

/**
 * The ONE place inbound email HTML is rendered (spec §5: `bodyHtml` is
 * untrusted, unsanitized, attacker-controlled — a stored-XSS vector against
 * the Agent). Every byte passes through DOMPurify in the browser before it
 * touches the DOM, inside a container that constrains layout blowouts.
 * Remote images are stripped for now (a click-to-load affordance is a later
 * increment) — an inbound `<img>` is also a tracking pixel aimed at the
 * Agent.
 */

import DOMPurify from 'dompurify'
import { useMemo } from 'react'

export function SanitizedHtml({ html }: { html: string }) {
  const clean = useMemo(
    () =>
      DOMPurify.sanitize(html, {
        USE_PROFILES: { html: true },
        // Every element or attribute that makes the browser fetch a remote
        // resource or overlay the app is stripped, not just <img>: table
        // `background`, media `poster`/`src`, and `<dialog open>` all survive
        // the html profile otherwise.
        FORBID_TAGS: [
          'img',
          'style',
          'form',
          'input',
          'button',
          'video',
          'audio',
          'source',
          'track',
          'picture',
          'dialog',
        ],
        FORBID_ATTR: ['style', 'background', 'poster', 'srcset', 'popover'],
      }),
    [html],
  )

  return (
    <div
      style={{ maxWidth: '72ch', overflowWrap: 'break-word' }}
      // Sanitized immediately above — this is the sanctioned sink.
      // biome-ignore lint/security/noDangerouslySetInnerHtml: DOMPurify-sanitized on the line above; spec §5's required pattern
      dangerouslySetInnerHTML={{ __html: clean }}
    />
  )
}
