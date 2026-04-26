# Edge Case: Code Block Interaction Test

Text before code block.

```javascript
// Cursor should NOT be here - fences should be hidden
function hello() {
  console.log("Hello, World!");
  return 42;
}
```

Text between code blocks.

```python
# Another code block
def world():
    print("World!")
    return "done"
```

Text after code block.

---

## Cursor inside code block:

Move cursor into the block below — fences should appear:

```typescript
type Result<T> = {
  ok: true;
  value: T;
} | {
  ok: false;
  error: string;
};
```

When cursor is inside, you should see:
1. Opening ``` with language tag visible
2. Closing ``` visible
3. Content with normal editor background

When cursor moves out, you should see:
1. Opening ``` replaced with language label bar
2. Closing ``` replaced with bottom border
3. Content with uniform background color
