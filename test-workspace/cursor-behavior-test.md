# Edge Case: Cursor Behavior Test

**Click on each line below to verify cursor shows raw syntax**

## When cursor is ON the line, raw markdown should show:

**This bold text should show ** markers when cursor is here**

*This italic text should show * markers when cursor is here*

~~This strikethrough should show ~~ markers when cursor is here~~

`This inline code should show backticks when cursor is here`

> This blockquote should show > when cursor is here

- This list item should show - when cursor is here

1. This ordered list should show 1. when cursor is here

- [ ] This task should show - [ ] when cursor is here

---

## When cursor is OFF the line, rendered view should show:

**This bold text should NOT show ** markers**

*This italic text should NOT show * markers*

~~This strikethrough should NOT show ~~ markers~~

`This inline code should NOT show backticks`

> This blockquote should NOT show >

- This list item should NOT show -

1. This ordered list item should NOT show 1.

- [ ] This task should show a checkbox instead of - [ ]
