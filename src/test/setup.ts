import "@testing-library/jest-dom/vitest";

class ObserverMock {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): never[] {
    return [];
  }
}

Object.defineProperty(globalThis, "ResizeObserver", {
  value: ObserverMock,
  configurable: true,
});
Object.defineProperty(globalThis, "IntersectionObserver", {
  value: ObserverMock,
  configurable: true,
});

// jsdom does not implement the Web Animations API; Base UI internals call it.
Object.defineProperty(Element.prototype, "getAnimations", {
  value: () => [],
  configurable: true,
});