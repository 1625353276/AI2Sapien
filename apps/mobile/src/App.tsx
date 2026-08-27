import { StatusBar } from "expo-status-bar";
import {
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import type { RuntimeStatusSnapshot } from "@ai2sapien/contracts";

type MobileRuntimePreview = Pick<RuntimeStatusSnapshot, "connected" | "checkedAt">;

const runtimePreview: MobileRuntimePreview = {
  connected: false,
  checkedAt: new Date(0).toISOString(),
};

const roadmap = [
  { number: "01", title: "桌面同步", detail: "连接 Windows AI2Sapien，安全同步课程与学习进度。" },
  { number: "02", title: "移动复习", detail: "完成到期复习、错题回顾和近迁移小题。" },
  { number: "03", title: "离线作答", detail: "离线保存答案，恢复连接后写回证据记录。" },
] as const;

export function App() {
  return (
    <View style={styles.screen}>
      <StatusBar style="light" />
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.topBar}>
          <View style={styles.brandMark}><Text style={styles.brandMarkText}>AI²</Text></View>
          <View>
            <Text style={styles.brand}>AI2Sapien</Text>
            <Text style={styles.brandCn}>人工智人 · MOBILE</Text>
          </View>
          <View style={styles.reservedBadge}><Text style={styles.reservedText}>框架预留</Text></View>
        </View>

        <View style={styles.hero}>
          <Text style={styles.eyebrow}>MOBILE COMPANION</Text>
          <Text style={styles.title}>把理解，带到{`\n`}每一次复习里。</Text>
          <Text style={styles.description}>
            手机端先作为桌面学习空间的伴随端。Windows 版完成后，这里将承接复习、作答和进度同步。
          </Text>
          <View style={styles.connectionCard}>
            <View style={styles.connectionDot} />
            <View style={styles.connectionCopy}>
              <Text style={styles.connectionTitle}>等待连接桌面端</Text>
              <Text style={styles.connectionDetail}>不会直接暴露 Codex 或 ChatGPT 凭证</Text>
            </View>
            <Text style={styles.connectionState}>{runtimePreview.connected ? "在线" : "未连接"}</Text>
          </View>
        </View>

        <View style={styles.sectionHeader}>
          <Text style={styles.eyebrowDark}>PLANNED CAPABILITIES</Text>
          <Text style={styles.sectionTitle}>移动端路线</Text>
        </View>

        <View style={styles.roadmap}>
          {roadmap.map((item) => (
            <View style={styles.roadmapItem} key={item.number}>
              <Text style={styles.roadmapNumber}>{item.number}</Text>
              <View style={styles.roadmapCopy}>
                <Text style={styles.roadmapTitle}>{item.title}</Text>
                <Text style={styles.roadmapDetail}>{item.detail}</Text>
              </View>
            </View>
          ))}
        </View>

        <Text style={styles.footnote}>
          当前仅保留跨平台框架，不进入 Android/iOS 业务开发。
        </Text>
      </ScrollView>
    </View>
  );
}

const colors = {
  green: "#153f35",
  mint: "#dfece5",
  cream: "#f3f0e9",
  paper: "#fbfaf6",
  ink: "#1f2925",
  muted: "#6f7974",
  coral: "#ee8069",
  line: "#dfddd5",
};

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.green },
  content: {
    flexGrow: 1,
    paddingTop: Platform.OS === "android" ? 46 : 58,
    paddingHorizontal: 22,
    paddingBottom: 38,
  },
  topBar: { flexDirection: "row", alignItems: "center", marginBottom: 32 },
  brandMark: {
    width: 42,
    height: 42,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.25)",
    borderRadius: 13,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 11,
  },
  brandMarkText: { color: "white", fontWeight: "700", fontSize: 13 },
  brand: { color: "white", fontSize: 17, fontWeight: "700" },
  brandCn: { color: "rgba(255,255,255,0.5)", fontSize: 9, letterSpacing: 1.5, marginTop: 2 },
  reservedBadge: {
    marginLeft: "auto",
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 20,
    backgroundColor: "rgba(255,255,255,0.1)",
  },
  reservedText: { color: "rgba(255,255,255,0.68)", fontSize: 9 },
  hero: { paddingBottom: 30 },
  eyebrow: { color: "rgba(255,255,255,0.5)", fontSize: 9, fontWeight: "600", letterSpacing: 2.2 },
  title: { color: "white", fontSize: 37, lineHeight: 47, fontWeight: "700", letterSpacing: -1.1, marginTop: 13 },
  description: { color: "rgba(255,255,255,0.62)", fontSize: 13, lineHeight: 23, marginTop: 16 },
  connectionCard: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: 27,
    padding: 16,
    borderRadius: 17,
    backgroundColor: "rgba(255,255,255,0.08)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.1)",
  },
  connectionDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.coral, marginRight: 12 },
  connectionCopy: { flex: 1 },
  connectionTitle: { color: "white", fontSize: 12, fontWeight: "600" },
  connectionDetail: { color: "rgba(255,255,255,0.45)", fontSize: 9, marginTop: 4 },
  connectionState: { color: "rgba(255,255,255,0.55)", fontSize: 9 },
  sectionHeader: {
    backgroundColor: colors.cream,
    marginHorizontal: -22,
    paddingHorizontal: 22,
    paddingTop: 28,
    paddingBottom: 17,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
  },
  eyebrowDark: { color: "#89918d", fontSize: 8, fontWeight: "600", letterSpacing: 2 },
  sectionTitle: { color: colors.ink, fontSize: 21, fontWeight: "700", marginTop: 7 },
  roadmap: { backgroundColor: colors.cream, marginHorizontal: -22, paddingHorizontal: 22, paddingBottom: 25 },
  roadmapItem: {
    flexDirection: "row",
    backgroundColor: colors.paper,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.line,
    padding: 17,
    marginBottom: 10,
  },
  roadmapNumber: { color: colors.coral, fontSize: 16, fontWeight: "600", width: 42 },
  roadmapCopy: { flex: 1 },
  roadmapTitle: { color: colors.ink, fontSize: 13, fontWeight: "700" },
  roadmapDetail: { color: colors.muted, fontSize: 10, lineHeight: 17, marginTop: 5 },
  footnote: {
    color: "rgba(255,255,255,0.45)",
    fontSize: 9,
    textAlign: "center",
    marginTop: 20,
  },
});
