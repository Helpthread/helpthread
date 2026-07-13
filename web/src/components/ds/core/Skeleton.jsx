import React from 'react'

/** Pulsing placeholder bar/shape. */
export function Skeleton({ width = '100%', height = 12, radius = 4, style }) {
  return (
    <>
      <style>{'@keyframes ht-pulse{0%,100%{opacity:1}50%{opacity:.45}}'}</style>
      <div
        style={{
          width,
          height,
          borderRadius: radius,
          background: 'var(--ht-surface-2)',
          animation: 'ht-pulse 1.5s ease-in-out infinite',
          ...style,
        }}
      />
    </>
  )
}
