// Error-boundary behaviour: renders children normally, and on a render error shows the
// readable configuration fallback instead of a blank screen. SSR (renderToStaticMarkup)
// does not run React's error-recovery path, so the throw -> fallback transition is
// exercised via the documented getDerivedStateFromError mechanism React invokes.
import { describe, it, expect } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppErrorBoundary, AppErrorScreen } from "@/components/AppErrorBoundary";

describe("AppErrorBoundary", () => {
  it("renders children normally when nothing throws", () => {
    const html = renderToStaticMarkup(
      createElement(AppErrorBoundary, null, createElement("div", null, "normal-child")),
    );
    expect(html).toContain("normal-child");
    expect(html).not.toContain("could not start");
  });

  it("switches to the fallback when a child throws", () => {
    // React calls this static when a descendant throws during render.
    const next = AppErrorBoundary.getDerivedStateFromError();
    expect(next.hasError).toBe(true);

    const instance = new AppErrorBoundary({
      children: createElement("div", null, "normal-child"),
    });
    instance.state = next;
    const html = renderToStaticMarkup(instance.render() as ReactElement);
    expect(html).toContain("could not start");
    expect(html).not.toContain("normal-child");
  });

  it("fallback shows the admin-contact configuration message", () => {
    const html = renderToStaticMarkup(createElement(AppErrorScreen));
    expect(html).toContain("could not start");
    expect(html).toContain("configuration error");
    expect(html).toContain("contact the administrator");
  });
});
