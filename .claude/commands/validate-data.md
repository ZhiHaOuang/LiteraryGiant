Run the canonical data layout validator for the current test book:

```bash
conda run -n LitCodex python -m scripts.validate_data_layout --book-id 0001
```

Report errors first, then warnings, then the smallest fix needed to restore
manifest and artifact identity consistency.
