//! PDF text operators for standard Latin Type1 fonts. No glyph substitution or layout inference.
use crate::{
    pdf_container::{Document, get},
    pdf_syntax::{Dict, Lexer, Value, bad, limit, unsupported},
};
use ops_protocol::{Failure, Result};
use std::time::{Duration, Instant};
pub const MAX_TEXT: usize = 1024 * 1024;
pub fn deadline(started: Instant) -> Result<()> {
    if started.elapsed() >= Duration::from_secs(30) {
        return Err(Failure::new(
            "DEADLINE_EXCEEDED",
            "PDF reading reached its 30-second deadline",
        ));
    }
    Ok(())
}
#[derive(Clone, Copy)]
enum Encoding {
    Standard,
    WinAnsi,
}
fn font(doc: &Document<'_>, resources: &Dict, name: &[u8]) -> Result<Encoding> {
    let fonts = doc.resolve(get(resources, b"Font")?)?.dict()?;
    let font = doc.resolve(get(fonts, name)?)?.dict()?;
    if get(font, b"Type")?.name()? != b"Font" || get(font, b"Subtype")?.name()? != b"Type1" {
        return Err(unsupported("PDF text requires standard Latin Type1 fonts"));
    }
    if font.contains_key(b"ToUnicode".as_slice()) || font.contains_key(b"FontDescriptor".as_slice())
    {
        return Err(unsupported(
            "PDF embedded fonts and ToUnicode mappings are unsupported",
        ));
    }
    if !matches!(
        get(font, b"BaseFont")?.name()?,
        b"Helvetica"
            | b"Helvetica-Bold"
            | b"Helvetica-Oblique"
            | b"Helvetica-BoldOblique"
            | b"Courier"
            | b"Courier-Bold"
            | b"Courier-Oblique"
            | b"Courier-BoldOblique"
            | b"Times-Roman"
            | b"Times-Bold"
            | b"Times-Italic"
            | b"Times-BoldItalic"
    ) {
        return Err(unsupported(
            "PDF font is outside the standard Helvetica/Courier/Times families",
        ));
    }
    match font.get(b"Encoding".as_slice()) {
        None => Ok(Encoding::Standard),
        Some(Value::Name(name)) if name == b"WinAnsiEncoding" => Ok(Encoding::WinAnsi),
        _ => Err(unsupported(
            "PDF font requires built-in StandardEncoding or named WinAnsiEncoding; differences and other encodings are unsupported",
        )),
    }
}
fn text(bytes: &[u8], encoding: Encoding) -> Result<String> {
    // ISO 32000-1 Annex D: WinAnsi differs from a generic CP1252 decoder at bullet/space/hyphen slots.
    const C1: [char; 32] = [
        '€', '•', '‚', 'ƒ', '„', '…', '†', '‡', 'ˆ', '‰', 'Š', '‹', 'Œ', '•', 'Ž', '•', '•', '‘',
        '’', '“', '”', '•', '–', '—', '˜', '™', 'š', '›', 'œ', '•', 'ž', 'Ÿ',
    ];
    let mut output = String::new();
    for &byte in bytes {
        let c = match encoding {
            Encoding::Standard => match byte {
                39 => '’',
                96 => '‘',
                32..=126 => byte as char,
                _ => {
                    return Err(unsupported(
                        "PDF StandardEncoding character is outside the supported printable Latin subset",
                    ));
                }
            },
            Encoding::WinAnsi => match byte {
                32..=126 => byte as char,
                127 => '•',
                128..=159 => C1[(byte - 128) as usize],
                160 => ' ',
                173 => '-',
                161..=255 => byte as char,
                _ => {
                    return Err(unsupported(
                        "PDF WinAnsi character has no supported glyph mapping",
                    ));
                }
            },
        };
        if output.len() + c.len_utf8() > MAX_TEXT {
            return Err(limit("PDF text run exceeds 1 MiB"));
        }
        output.push(c);
    }
    Ok(output)
}
fn numeric(value: &Value) -> bool {
    matches!(value, Value::Integer(_) | Value::Number(_))
}
fn numbers(args: &[Value], count: usize) -> Result<()> {
    if args.len() != count || !args.iter().all(numeric) {
        return Err(bad("Invalid PDF numeric operator arguments"));
    }
    Ok(())
}
fn no_args(args: &[Value]) -> Result<()> {
    numbers(args, 0)
}
fn string(value: &Value, encoding: Encoding) -> Result<String> {
    match value {
        Value::String(bytes) => text(bytes, encoding),
        _ => Err(bad("PDF text-showing operand is not a string")),
    }
}
pub fn extract(
    doc: &Document<'_>,
    resources: Option<&Value>,
    bytes: &[u8],
    started: Instant,
) -> Result<Vec<String>> {
    if bytes.iter().all(|b| crate::pdf_syntax::white(*b)) {
        return Ok(Vec::new());
    }
    let mut lexer = Lexer::new(bytes);
    lexer.skip();
    if lexer.at == bytes.len() {
        return Ok(Vec::new());
    }
    let mut args = Vec::new();
    let (mut inside, mut selected, mut stack) = (false, None, Vec::new());
    let (mut runs, mut text_bytes) = (Vec::new(), 0usize);
    loop {
        deadline(started)?;
        lexer.skip();
        if lexer.at == bytes.len() {
            break;
        }
        let b = bytes[lexer.at];
        if b.is_ascii_digit() || b"+-./(<[".contains(&b) {
            if args.len() >= 64 {
                return Err(limit("PDF operator exceeds 64 operands"));
            }
            args.push(lexer.value(0)?);
            continue;
        }
        let op = lexer.word()?;
        if inside
            && !matches!(
                op,
                b"ET"
                    | b"Tf"
                    | b"Tj"
                    | b"TJ"
                    | b"'"
                    | b"\""
                    | b"T*"
                    | b"Td"
                    | b"TD"
                    | b"Tm"
                    | b"Tc"
                    | b"Tw"
                    | b"Tz"
                    | b"TL"
                    | b"Ts"
                    | b"Tr"
                    | b"BT"
            )
        {
            return Err(bad("Non-text PDF operator inside a text object"));
        }
        let mut shown = None;
        match op {
            b"BT" => {
                no_args(&args)?;
                if inside {
                    return Err(bad("Nested PDF text objects"));
                }
                inside = true
            }
            b"ET" => {
                no_args(&args)?;
                if !inside {
                    return Err(bad("PDF ET outside text object"));
                }
                inside = false
            }
            b"Tf" => {
                if !inside || args.len() != 2 || !numeric(&args[1]) {
                    return Err(bad("Invalid PDF Tf text state"));
                }
                let resources = doc
                    .resolve(resources.ok_or_else(|| bad("Missing PDF page Resources"))?)?
                    .dict()?;
                selected = Some(font(doc, resources, args[0].name()?)?);
            }
            b"Tj" | b"TJ" | b"'" | b"\"" => {
                if !inside {
                    return Err(bad("PDF text show outside text object"));
                }
                let encoding = selected
                    .ok_or_else(|| bad("PDF text show before a supported font is selected"))?;
                shown = Some(match op {
                    b"TJ" => {
                        if args.len() != 1 {
                            return Err(bad("Invalid PDF TJ arguments"));
                        }
                        let Value::Array(parts) = &args[0] else {
                            return Err(bad("PDF TJ operand is not an array"));
                        };
                        let mut run = String::new();
                        for part in parts {
                            if numeric(part) {
                                continue;
                            }
                            let fragment = string(part, encoding)?;
                            if run.len() + fragment.len() > MAX_TEXT {
                                return Err(limit("PDF text run exceeds 1 MiB"));
                            }
                            run.push_str(&fragment);
                        }
                        run
                    }
                    b"\"" => {
                        if args.len() != 3 {
                            return Err(bad("Invalid PDF quote arguments"));
                        }
                        numbers(&args[..2], 2)?;
                        string(&args[2], encoding)?
                    }
                    _ => {
                        if args.len() != 1 {
                            return Err(bad("Invalid PDF text-show arguments"));
                        }
                        string(&args[0], encoding)?
                    }
                });
            }
            b"T*" | b"Td" | b"TD" | b"Tm" | b"Tc" | b"Tw" | b"Tz" | b"TL" | b"Ts" | b"Tr" => {
                if !inside {
                    return Err(bad("PDF text positioning outside text object"));
                }
                let count = match op {
                    b"T*" => 0,
                    b"Td" | b"TD" => 2,
                    b"Tm" => 6,
                    _ => 1,
                };
                numbers(&args, count)?;
                if op == b"Tr" && !matches!(args[0], Value::Integer(0..=7)) {
                    return Err(bad("Invalid PDF text rendering mode"));
                }
            }
            b"q" => {
                no_args(&args)?;
                if inside {
                    return Err(unsupported("PDF q inside a text object is unsupported"));
                }
                if stack.len() >= 64 {
                    return Err(limit("PDF graphics state exceeds depth 64"));
                }
                stack.push(selected)
            }
            b"Q" => {
                no_args(&args)?;
                if inside {
                    return Err(unsupported("PDF Q inside a text object is unsupported"));
                }
                selected = stack.pop().ok_or_else(|| bad("Unbalanced PDF Q"))?
            }
            b"cm" | b"c" => numbers(&args, 6)?,
            b"v" | b"y" | b"re" | b"k" | b"K" => numbers(&args, 4)?,
            b"rg" | b"RG" => numbers(&args, 3)?,
            b"m" | b"l" => numbers(&args, 2)?,
            b"w" | b"J" | b"j" | b"M" | b"i" | b"g" | b"G" => numbers(&args, 1)?,
            b"h" | b"S" | b"s" | b"f" | b"F" | b"f*" | b"B" | b"B*" | b"b" | b"b*" | b"n"
            | b"W" | b"W*" => no_args(&args)?,
            b"d" => {
                if args.len() != 2
                    || !numeric(&args[1])
                    || !matches!(&args[0],Value::Array(v) if v.iter().all(numeric))
                {
                    return Err(bad("Invalid PDF dash arguments"));
                }
            }
            b"ri" => {
                if args.len() != 1 {
                    return Err(bad("Invalid PDF rendering intent arguments"));
                }
                args[0].name()?;
            }
            _ => {
                return Err(unsupported(format!(
                    "Unsupported PDF content operator {}; forms, images, marked content and external graphics state are not traversed",
                    String::from_utf8_lossy(op)
                )));
            }
        }
        if let Some(run) = shown {
            if runs.len() >= 10_000 || text_bytes + run.len() + 1 > MAX_TEXT {
                return Err(limit("PDF page text exceeds 1 MiB or 10000 runs"));
            }
            text_bytes += run.len() + 1;
            runs.push(run);
        }
        args.clear();
    }
    if inside || !stack.is_empty() || !args.is_empty() {
        return Err(bad("Unclosed PDF text/graphics state or dangling operands"));
    }
    if runs.iter().all(String::is_empty) {
        return Err(unsupported(
            "PDF content has no supported text layer; OCR is not provided",
        ));
    }
    Ok(runs)
}
