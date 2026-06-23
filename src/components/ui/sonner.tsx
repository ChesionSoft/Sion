"use client";

import { Toaster as SonnerToaster } from "sonner";

/**
 * App-wide toast host. Mounted once in the root layout; copy actions elsewhere
 * call `toast.success(...)` from the `sonner` package directly.
 */
export function Toaster(props: React.ComponentProps<typeof SonnerToaster>) {
  return <SonnerToaster richColors position="top-center" closeButton {...props} />;
}