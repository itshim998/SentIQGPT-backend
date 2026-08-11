enum AdaptiveWindowClass { compact, medium, expanded }

AdaptiveWindowClass classifyWindow(double width) {
  if (width >= 900) return AdaptiveWindowClass.expanded;
  if (width >= 600) return AdaptiveWindowClass.medium;
  return AdaptiveWindowClass.compact;
}
