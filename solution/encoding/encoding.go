package encoding

func AppendUvarint(dst []byte, v uint64) []byte {
	for v >= 0x80 {
		dst = append(dst, byte(v)|0x80)
		v >>= 7
	}
	return append(dst, byte(v))
}

func Uvarint(src []byte) (uint64, int) {
	var v uint64
	for i, b := range src {
		if i == 10 {
			return 0, -1
		}
		if b < 0x80 {
			if i == 9 && b > 1 {
				return 0, -1
			}
			return v | uint64(b)<<(7*uint(i)), i + 1
		}
		v |= uint64(b&0x7f) << (7 * uint(i))
	}
	return 0, 0
}

func AppendFixed32(dst []byte, v uint32) []byte {
	return append(dst, byte(v), byte(v>>8), byte(v>>16), byte(v>>24))
}

func Fixed32(src []byte) uint32 {
	_ = src[3]
	return uint32(src[0]) | uint32(src[1])<<8 | uint32(src[2])<<16 | uint32(src[3])<<24
}

func AppendFixed64(dst []byte, v uint64) []byte {
	return append(dst, byte(v), byte(v>>8), byte(v>>16), byte(v>>24), byte(v>>32), byte(v>>40), byte(v>>48), byte(v>>56))
}

func Fixed64(src []byte) uint64 {
	_ = src[7]
	return uint64(Fixed32(src)) | uint64(Fixed32(src[4:]))<<32
}

func AppendLengthPrefixed(dst, b []byte) []byte {
	dst = AppendUvarint(dst, uint64(len(b)))
	return append(dst, b...)
}

func LengthPrefixed(src []byte) (b, rest []byte, ok bool) {
	n, w := Uvarint(src)
	if w <= 0 || n > uint64(len(src)-w) {
		return nil, nil, false
	}
	return src[w : w+int(n)], src[w+int(n):], true
}
