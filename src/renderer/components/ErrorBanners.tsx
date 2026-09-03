import type { Banner } from '../store'

export function ErrorBanners({ errors, onDismiss }: { errors: Banner[]; onDismiss: (id: number) => void }) {
  if (errors.length === 0) return null
  return (
    <div className="banners">
      {errors.map((e) => (
        <div key={e.id} className="banner">
          <span>{e.message}</span>
          <button className="link" onClick={() => onDismiss(e.id)}>
            ✕
          </button>
        </div>
      ))}
    </div>
  )
}
