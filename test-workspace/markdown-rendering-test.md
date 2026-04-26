# Markdown Rendering Test Suite

This document comprehensively tests all Markdown rendering features to verify Obsidian-like live preview experience.

---

## 1. Headings

# H1 Heading

## H2 Heading

### H3 Heading

#### H4 Heading

##### H5 Heading

###### H6 Heading

---

## 2. Bold, Italic, and Strikethrough

**Bold text should render with bold font weight**

*Italic text should render with italic font style*

***Bold and italic text should render with both***

~~Strikethrough text should render with line-through~~

**Bold with `inline code` inside**

*Italic with **nested bold** inside*

---

## 3. Inline Code

This is `inline code` in a sentence.

Multiple `code` fragments `in one` line.

`Standalone inline code on its own`

A longer example: `const greeting: string = "Hello, World!";`

---

## 4. Blockquotes

> This is a single-line blockquote.

> This is a multi-line blockquote.
> It should have a purple left border.
> And the text should be slightly muted and italic.

> **Bold in blockquote** should still work.

> *Italic in blockquote* should also work.

> `Inline code in blockquote` too.

---

## 5. Ordered Lists

1. First item
2. Second item
3. Third item
4. Fourth item with **bold text**
5. Fifth item with `inline code`

---

## 6. Unordered Lists

- Apple
- Banana
- Cherry
- Date with *italic text*
- Elderberry with `code`

* Alternative bullet style
* Another alternative

+ Plus bullet style
+ Yet another

---

## 7. Task Lists

- [x] Completed task
- [ ] Incomplete task
- [x] Another completed task with **bold**
- [ ] Incomplete task with `code`

---

## 8. Nested Lists

1. First level
   - Nested unordered item
   - Another nested item
2. Second level
   1. Nested ordered item
   2. Another nested ordered
3. Back to first level

---

## 9. Code Blocks

```typescript
interface User {
  id: number;
  name: string;
  email: string;
}

function greet(user: User): string {
  return `Hello, ${user.name}!`;
}
```

```python
def fibonacci(n: int) -> list[int]:
    """Generate Fibonacci sequence."""
    a, b = 0, 1
    result = []
    while a < n:
        result.append(a)
        a, b = b, a + b
    return result
```

```json
{
  "name": "PaperLink",
  "version": "0.1.0",
  "features": ["markdown", "pdf", "links"]
}
```

A plain code block without language:

```
This is a code block
without any language specified.
It should still render properly.
```

---

## 10. Images

![Obsidian Logo](https://obsidian.md/images/obsidian-logo-gradient.svg)

![Small icon](https://upload.wikimedia.org/wikipedia/commons/4/48/Markdown-mark.svg)

A broken image with fallback:
![Non-existent image](https://example.com/does-not-exist.png)

---

## 11. Horizontal Rules

Above the first rule.

---

Between two rules.

***

Another rule with underscores.

___

---

## 12. Links

This is a [regular link](https://obsidian.md) in text.

Another [link to GitHub](https://github.com) here.

Multiple links: [Google](https://google.com) and [DuckDuckGo](https://duckduckgo.com) in one line.

---

## 13. Mixed Formatting

This paragraph has **bold**, *italic*, ***bold-italic***, ~~strikethrough~~, and `inline code` all together.

**Bold text containing *nested italic* and `code`**

*Italic text containing **nested bold** and ~~strikethrough~~*

> Blockquote with **bold**, *italic*, and `code` mixed in.

---

## 14. Edge Cases

Multiple     spaces    should    be    preserved.

Empty lines below:

Above empty line.

Special characters: & < > " ' © ® ™

Unicode: 你好世界 🎉 こんにちは 한국어

---

## 15. Lists with Formatting

- Item with **bold**
- Item with *italic*
- Item with `code`
- Item with ~~strikethrough~~
- Item with [link](https://example.com)
- [ ] Task with **bold**
- [x] Task with `code`

---

## 16. Consecutive Formatting

**First bold** and **second bold** in one line.

*First italic* and *second italic* in one line.

`First code` and `Second code` in one line.

~~First strike~~ and ~~Second strike~~ in one line.

---

## 17. Blockquote Variations

> Single line

> >
> Empty blockquote continuation

> # Heading in blockquote
> **Bold in blockquote heading**

---

*End of test document. All rendering features should be verified above.*
