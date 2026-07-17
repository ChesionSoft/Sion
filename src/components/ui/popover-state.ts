type ClosestTarget = { closest: (selector: string) => unknown };

export function shouldClosePopoverAfterAction(target: unknown): boolean {
  return Boolean(target && typeof (target as Partial<ClosestTarget>).closest === "function" && (target as ClosestTarget).closest("button, [role='menuitem']"));
}
