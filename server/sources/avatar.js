/**
 * BARCELLOMETRO - Estrazione robusta dell'avatar dagli eventi TikTok v2.
 * Il campo canonico del protobuf è profilePicture.url (array di stringhe),
 * ma a seconda dell'evento/versione l'avatar sta in path diversi.
 * (Logica allineata a TokScope, confermata via dump del protobuf.)
 */
function pickAvatar(data) {
  const u = data?.user || {};
  const arrays = [
    u.profilePicture?.url, u.profile_picture?.url, data?.profilePicture?.url,
    u.profilePicture?.urls, u.profilePicture?.urlList, u.profilePicture?.url_list,
    u.avatarThumb?.urlList, u.avatarThumb?.url_list, u.avatarThumb?.url,
    u.avatar_thumb?.urlList, u.avatar_thumb?.url_list, u.avatar_thumb?.url,
    u.avatarMedium?.urlList, u.avatarMedium?.url,
    u.avatarLarger?.urlList, u.avatarLarger?.url,
    u.avatar?.urlList, u.avatar?.url_list, u.avatar?.urls, u.avatar?.url,
    data?.avatarThumb?.urlList, data?.avatarThumb?.url, data?.profilePicture?.urls,
  ];
  for (const p of arrays) {
    if (Array.isArray(p)) {
      const first = p.find((x) => typeof x === 'string' && x.length > 0);
      if (first) return first;
    } else if (typeof p === 'string' && p.length > 0) {
      return p;
    }
  }
  const strs = [
    u.profilePictureUrl, u.profile_picture_url, u.avatarThumbUrl,
    u.avatar_thumb_url, u.avatarUrl, u.avatar_url, data?.profilePictureUrl,
  ];
  for (const s of strs) {
    if (typeof s === 'string' && s.length > 0) return s;
  }
  return null;
}

module.exports = { pickAvatar };
