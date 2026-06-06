from __future__ import annotations

from .schemas import ChapterSynopsis, PlotWindow


class SlidingWindowPlanner:
    def __init__(
        self,
        *,
        window_size: int = 20,
        window_overlap: int = 10,
        min_window_size: int = 8,
    ) -> None:
        self.window_size = max(2, int(window_size))
        self.window_overlap = max(0, min(int(window_overlap), self.window_size - 1))
        self.min_window_size = max(2, min(int(min_window_size), self.window_size))

    def build_windows(self, chapters: list[ChapterSynopsis]) -> list[PlotWindow]:
        ordered = sorted(chapters, key=lambda item: item.order)
        if not ordered:
            return []

        total = len(ordered)
        step = max(1, self.window_size - self.window_overlap)
        starts: list[int] = []
        start = 0

        while start < total:
            if total - start < self.min_window_size and total > self.window_size:
                start = max(0, total - self.window_size)
            if starts and start <= starts[-1]:
                break
            starts.append(start)
            if start + self.window_size >= total:
                break
            start += step

        windows: list[PlotWindow] = []
        for index, start in enumerate(starts, start=1):
            chunk = ordered[start:start + self.window_size]
            if len(chunk) < self.min_window_size and windows:
                continue
            windows.append(
                PlotWindow(
                    window_id=f"window_{index:03d}",
                    window_index=index,
                    start_order=chunk[0].order,
                    end_order=chunk[-1].order,
                    chapter_orders=[chapter.order for chapter in chunk],
                    chapters=chunk,
                )
            )
        return windows
