export function validateProfile(profile) {
  if (!profile || typeof profile !== "object") throw new Error("絵文字と色を選んでください。");
  const {emoji,color}=profile;
  if (typeof emoji !== "string" || emoji.length>32 || [...new Intl.Segmenter("ja",{granularity:"grapheme"}).segment(emoji)].length!==1 || !/[\p{Extended_Pictographic}\p{Regional_Indicator}]/u.test(emoji))
    throw new Error("アイコンには絵文字を1つ選んでください。");
  if (typeof color !== "string" || !/^#[a-f0-9]{6}$/i.test(color)) throw new Error("アイコンの色を選んでください。");
  return {emoji,color:color.toLowerCase()};
}
