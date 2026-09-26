import { cn } from "@/lib/cn";

export function DialogFrame({
  titleId,
  title,
  onClose,
  dialogRef,
  widthClass = "max-w-lg",
  children,
}: Readonly<{
  titleId: string;
  title: string;
  onClose: () => void;
  dialogRef: React.RefObject<HTMLDivElement | null>;
  widthClass?: string;
  children: React.ReactNode;
}>): React.ReactElement {
  return (
    <div className="fixed inset-0 z-70 flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Dismiss"
        onClick={onClose}
        className="absolute inset-0 bg-slate-900/40"
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={cn(
          "relative w-full rounded-lg border border-slate-200 bg-white p-6 shadow-sm",
          widthClass,
        )}
      >
        <h2 id={titleId} className="text-xl font-semibold text-slate-900">
          {title}
        </h2>
        {children}
      </div>
    </div>
  );
}
