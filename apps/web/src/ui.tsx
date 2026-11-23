import { useEffect, useRef, type ReactNode } from 'react';

/** Modal built on <dialog>: native focus trap, Esc to close, focus restored to the trigger. */
export function Dialog({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current!;
    if (!d.open) d.showModal();
    // No close() in cleanup: unmounting removes the dialog (and its modal state) and a close event here would call onClose.
  }, []);
  return (
    <dialog
      ref={ref} className={wide ? 'dialog wide' : 'dialog'} aria-labelledby="dialog-title"
      onClose={onClose} onClick={(e) => { if (e.target === ref.current) onClose(); }}
    >
      <div className="dialog-head">
        <h2 id="dialog-title">{title}</h2>
        <button type="button" className="icon-btn" aria-label="Cerrar" onClick={onClose}>×</button>
      </div>
      <div className="dialog-body">{children}</div>
    </dialog>
  );
}

export function Alert({ children }: { children: ReactNode }) {
  return <p role="alert" className="alert">{children}</p>;
}

export const STATUS_LABEL: Record<string, string> = {
  CONFIRMED: 'Confirmado', IN_PROGRESS: 'En curso', COMPLETED: 'Atendido', NO_SHOW: 'No asistió',
  CANCELLED: 'Cancelado', NEEDS_REVIEW: 'Requiere revisión', SYNC_CONFLICT: 'Conflicto',
};
