# Display avatars

PNG derivatives preserve alpha and the original framing. Agent portraits display at 54 CSS pixels (162 × 162 at 3×); companions display at 34 CSS pixels (102 × 102 at 3×). Original 1254 × 1254 assets remain in the parent directory and are not imported into the client bundle.

Regenerate on macOS with `sips -z 162 162 ../analysis-avatar.png --out analysis-avatar.png` (same for the other three role portraits), and `sips -z 102 102 ../frog-transparent.png --out frog-transparent.png` (same for the other five companions). No runtime image library is needed.
