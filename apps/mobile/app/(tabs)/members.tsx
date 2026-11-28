import { ScrollView } from 'react-native';
import { CommunityMembers } from '@/components/CommunityMembers';
import { useBuzzTheme } from '@/theme/ThemeProvider';

export default function CommunityRoster() {
  const { colors } = useBuzzTheme();
  return (
    <ScrollView
      contentContainerStyle={{ padding: 16 }}
      style={{ backgroundColor: colors.surface }}
    >
      <CommunityMembers initiallyExpanded />
    </ScrollView>
  );
}
