'use client';

/* Last-resort error page (the root layout itself failed), so no providers are available. */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="da">
      <body
        style={{
          fontFamily: 'system-ui, sans-serif',
          display: 'grid',
          placeItems: 'center',
          minHeight: '100vh',
          margin: 0,
          background: '#fff',
          color: '#111113',
        }}
      >
        <main style={{ textAlign: 'center', padding: 24 }}>
          <p style={{ color: '#B42318', fontWeight: 600 }}>500</p>
          <h1 style={{ fontSize: 28, margin: '8px 0' }}>Noget gik i vandhullet</h1>
          <p style={{ color: '#52525B' }}>Something went wrong on our side. Try again.{error.digest ? ` Reference: ${error.digest}` : ''}</p>
          <button
            onClick={reset}
            style={{ marginTop: 24, background: '#D92D20', color: '#fff', border: 0, borderRadius: 6, padding: '10px 16px', fontWeight: 500 }}
          >
            Prøv igen
          </button>
        </main>
      </body>
    </html>
  );
}
